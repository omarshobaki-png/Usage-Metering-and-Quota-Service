import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { consume, type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for recovery tests.");

const schemaName = `recovery_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const testPool = new Pool({
  connectionString: databaseUrl, options: `-c search_path=${schemaName}`,
  max: 1, connectionTimeoutMillis: 1_000
});
const testPepper = "failure-recovery-test-pepper";
const apps: FastifyInstance[] = [];
let fixture: TwoAccountFixture;

function createTestApp(options: ConsumeOptions = {}) {
  const app = buildApp({
    checkDatabase: async () => { await testPool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(testPool, testPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(testPool, accountId, input),
      getUser: async (accountId, userId) => getUser(testPool, accountId, userId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(testPool, accountId, input, {
        clock: () => new Date("2026-10-17T12:30:00.000Z"), ...options
      })
    },
    logger: false
  });
  apps.push(app);
  return app;
}

function postConsume(app: FastifyInstance, units: number, requestId: string) {
  return app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { userId: fixture.userA.id, units, requestId }
  });
}

async function readState() {
  const account = await testPool.query("SELECT to_jsonb(t) AS row FROM account_monthly_usage t ORDER BY account_id, usage_month");
  const users = await testPool.query("SELECT to_jsonb(t) AS row FROM user_monthly_usage t ORDER BY user_id, usage_month");
  const decisions = await testPool.query("SELECT to_jsonb(t) AS row FROM request_decisions t ORDER BY account_id, request_id");
  return { account: account.rows, users: users.rows, decisions: decisions.rows };
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  await testPool.query(`
    DELETE FROM request_decisions;
    DELETE FROM user_monthly_usage;
    DELETE FROM account_monthly_usage;
    DELETE FROM users;
    DELETE FROM plans WHERE owner_account_id IS NOT NULL;
    DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(testPool, testPepper);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await testPool.query(`
    DROP TRIGGER IF EXISTS recovery_commit_failure ON request_decisions;
    DROP FUNCTION IF EXISTS recovery_commit_failure();
  `);
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("failure before commit and safe recovery", () => {
  for (const initial of [0, 7]) {
    it.each(["afterLock", "afterAccountIncrement", "afterDecisionInsert", "commit"] as const)(
      `rolls back a fault at %s with initial usage ${initial} and permits one same-ID recovery`,
      async (stage) => {
        const normal = createTestApp();
        if (initial > 0) {
          const seed = await postConsume(normal, initial, "existing-usage");
          expect(seed.statusCode).toBe(200);
          expect(seed.json().accepted).toBe(true);
        }
        const before = await readState();
        const connection = await testPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const privateMessage = `private SQL ${fixture.accountA.apiKey} postgres://private:secret@db`;
        let options: ConsumeOptions = {};
        if (stage === "afterLock") options = { clock: () => { throw new Error(privateMessage); } };
        if (stage === "afterAccountIncrement") options = { testHooks: {
          afterAccountIncrement: async (client) => { await client.query("SELECT 1 / 0"); }
        } };
        if (stage === "afterDecisionInsert") options = { testHooks: {
          afterDecisionInsert: () => { throw new Error(privateMessage); }
        } };
        if (stage === "commit") {
          await testPool.query(`
            CREATE FUNCTION recovery_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'private commit failure' USING ERRCODE = 'P0001'; END $$;
            CREATE CONSTRAINT TRIGGER recovery_commit_failure
            AFTER INSERT ON request_decisions DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW WHEN (NEW.request_id = 'recoverable-fault')
            EXECUTE FUNCTION recovery_commit_failure();
          `);
        }
        const failed = await postConsume(createTestApp(options), 4, "recoverable-fault");
        expect(failed.statusCode).toBe(500);
        expect(failed.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
        expect(failed.json()).not.toHaveProperty("accepted");
        expect(failed.json().correlationId).toEqual(expect.any(String));
        for (const secret of [fixture.accountA.apiKey, testPepper, "postgres://", "private", "secret", "SELECT", "division by zero", "P0001"]) {
          expect(failed.body).not.toContain(secret);
        }
        expect(await readState()).toEqual(before);
        expect(testPool.idleCount).toBe(1);
        expect(testPool.waitingCount).toBe(0);
        expect((await testPool.query("SELECT pg_backend_pid() AS pid")).rows).toEqual(connection.rows);
        if (stage === "commit") await testPool.query("DROP TRIGGER recovery_commit_failure ON request_decisions");
        const recovered = await postConsume(normal, 4, "recoverable-fault");
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toMatchObject({ accepted: true,
          account: { consumed: initial + 4 }, user: { consumed: initial + 4 }
        });
        const after = await readState();
        expect(after.decisions).toHaveLength(initial > 0 ? 2 : 1);
        const replay = await postConsume(normal, 4, "recoverable-fault");
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(recovered.json());
        expect(await readState()).toEqual(after);
      }
    );
  }

  it("recovers the committed response when the caller discards it, without another charge", async () => {
    const app = createTestApp();
    // Deliberately retain no response body from the successful first attempt.
    expect((await postConsume(app, 4, "lost-after-commit")).statusCode).toBe(200);
    const before = await readState();
    const saved = await testPool.query<{ response: unknown }>(
      "SELECT decision_snapshot->'response' AS response FROM request_decisions WHERE account_id = $1 AND request_id = $2",
      [fixture.accountA.id, "lost-after-commit"]
    );
    expect(saved.rows).toHaveLength(1);
    const retry = await postConsume(createTestApp(), 4, "lost-after-commit");
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(saved.rows[0]!.response);
    expect(await readState()).toEqual(before);
  });
});
