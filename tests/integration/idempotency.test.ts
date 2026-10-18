import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { assignUserPlan } from "../../src/modules/plans/assignment.js";
import { updateCustomPlan } from "../../src/modules/plans/service.js";
import { consume, type ConsumeOptions } from "../../src/modules/usage/consume.js";
import type { ConsumptionDecision } from "../../src/modules/usage/contract.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for idempotency tests.");
}

const schemaName = `idempotency_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolConfig = { connectionString: databaseUrl, options: `-c search_path=${schemaName}` };
const adminPool = new Pool({ connectionString: databaseUrl });
let testPool = new Pool(poolConfig);
const testPepper = "idempotency-test-pepper";
const instant = "2026-10-31T23:59:59.000Z";
const apps: FastifyInstance[] = [];
let fixture: TwoAccountFixture;

function createTestApp(options: ConsumeOptions = {}): FastifyInstance {
  // Capture this pool: replacing the app and pool must not reuse process-local state.
  const pool = testPool;
  const app = buildApp({
    checkDatabase: async () => { await pool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(pool, testPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(pool, accountId, input),
      getUser: async (accountId, userId) => getUser(pool, accountId, userId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(pool, accountId, input, {
        clock: () => new Date(instant), ...options
      })
    },
    logger: false
  });
  apps.push(app);
  return app;
}

async function postConsume(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  apiKey: string | null = fixture.accountA.apiKey
) {
  return app.inject({
    method: "POST", url: "/consume",
    headers: apiKey === null ? {} : { "x-api-key": apiKey }, payload
  });
}

// Include every persisted field (including timestamps), not just the totals.
async function readState(accountId = fixture.accountA.id) {
  const accounts = await testPool.query(
    "SELECT to_jsonb(t) AS row FROM account_monthly_usage t WHERE account_id = $1 ORDER BY usage_month",
    [accountId]
  );
  const users = await testPool.query(
    "SELECT to_jsonb(t) AS row FROM user_monthly_usage t WHERE account_id = $1 ORDER BY user_id, usage_month",
    [accountId]
  );
  const decisions = await testPool.query(
    "SELECT to_jsonb(t) AS row FROM request_decisions t WHERE account_id = $1 ORDER BY request_id",
    [accountId]
  );
  return { accounts: accounts.rows, users: users.rows, decisions: decisions.rows };
}

async function expectAccounting(total: number, decisions: number, accountId = fixture.accountA.id) {
  const result = await testPool.query(
    `SELECT
       (SELECT COALESCE(SUM(consumed_units), 0)::integer FROM account_monthly_usage WHERE account_id = $1) AS account,
       (SELECT COALESCE(SUM(consumed_units), 0)::integer FROM user_monthly_usage WHERE account_id = $1) AS users,
       (SELECT COALESCE(SUM(requested_units) FILTER (WHERE accepted), 0)::integer FROM request_decisions WHERE account_id = $1) AS ledger,
       (SELECT COUNT(*)::integer FROM request_decisions WHERE account_id = $1) AS decisions`,
    [accountId]
  );
  expect(result.rows).toEqual([{ account: total, users: total, ledger: total, decisions }]);
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  // Only this test file's randomly named schema is on the pool's search path.
  await testPool.query(`
    DELETE FROM request_decisions;
    DELETE FROM user_monthly_usage;
    DELETE FROM account_monthly_usage;
    DELETE FROM users;
    UPDATE accounts SET account_plan_id = 1;
    DELETE FROM plans WHERE owner_account_id IS NOT NULL;
    DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(testPool, testPepper);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("account-scoped consumption retries with PostgreSQL", () => {
  it("replays a 4-unit acceptance five times without any additional writes", async () => {
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 4, requestId: "accepted-retry" };
    const first = await postConsume(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toBe(true);
    const saved = await readState();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Property order and UUID letter case do not change the semantic payload.
      const retry = await postConsume(app, {
        requestId: payload.requestId, units: 4, userId: payload.userId.toUpperCase()
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
    }
    expect(await readState()).toEqual(saved);
    await expectAccounting(4, 1);
  });

  it("keeps the old accepted balances after more usage and a plan change", async () => {
    await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, fixture.customPlanA.id);
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 4, requestId: "historical-accept" };
    const first = await postConsume(app, payload);
    expect(first.json()).toMatchObject({ accepted: true, user: { consumed: 4, remaining: 46 } });
    const later = await postConsume(app, { ...payload, units: 3, requestId: "later-usage" });
    expect(later.json().accepted).toBe(true);
    await updateCustomPlan(testPool, fixture.accountA.id, fixture.customPlanA.id, {
      monthlyLimit: 100, requestLimit: 0
    });
    const saved = await readState();
    const noNewTime = vi.fn(() => { throw new Error("A replay must not capture a new time."); });
    const retry = await postConsume(createTestApp({ clock: noNewTime }), payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(noNewTime).not.toHaveBeenCalled();
    expect(await readState()).toEqual(saved);
    await expectAccounting(7, 2);
  });

  it("keeps a 6-unit rejection against cap 5 after an upgrade to 10; a new ID succeeds", async () => {
    await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, fixture.customPlanA.id);
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 6, requestId: "rejected-before-upgrade" };
    const first = await postConsume(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      accepted: false, blockedBy: { scope: "user", rule: "max_units_per_request", limit: 5 }
    });
    await updateCustomPlan(testPool, fixture.accountA.id, fixture.customPlanA.id, { requestLimit: 10 });
    const saved = await readState();
    const retry = await postConsume(app, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await readState()).toEqual(saved);
    const newAttempt = await postConsume(app, { ...payload, requestId: "new-after-upgrade" });
    expect(newAttempt.statusCode).toBe(200);
    expect(newAttempt.json()).toMatchObject({ accepted: true, user: { plan: { revision: 2 } } });
    await expectAccounting(6, 2);
  });

  it.each([4, 25])("rejects changed units and a different owned user after a %i-unit decision", async (units) => {
    const secondUser = await createUser(testPool, fixture.accountA.id);
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units, requestId: "payload-conflict" };
    const first = await postConsume(app, payload);
    expect(first.statusCode).toBe(200);
    const saved = await readState();
    for (const changed of [{ ...payload, units: units + 1 }, { ...payload, userId: secondUser.id }]) {
      const conflict = await postConsume(app, changed);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "REQUEST_ID_CONFLICT" } });
      expect(await readState()).toEqual(saved);
    }
    const retry = await postConsume(app, payload);
    expect(retry.json()).toEqual(first.json());
    await expectAccounting(units === 4 ? 4 : 0, 1);
  });

  it("allows the same ID independently in another account without leaking the first decision", async () => {
    const app = createTestApp();
    const first = await postConsume(app, { userId: fixture.userA.id, units: 4, requestId: "shared-id" });
    expect(first.statusCode).toBe(200);
    const savedA = await readState();
    const payloadB = { userId: fixture.userB.id, units: 7, requestId: "shared-id" };
    const second = await postConsume(app, payloadB, fixture.accountB.apiKey);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ...payloadB, accepted: true, account: { consumed: 7 } });
    expect(second.json()).not.toEqual(first.json());
    const retryB = await postConsume(app, payloadB, fixture.accountB.apiKey);
    expect(retryB.json()).toEqual(second.json());
    expect(await readState()).toEqual(savedA);
    const savedB = await readState(fixture.accountB.id);
    const foreign = await postConsume(app, { ...payloadB, userId: fixture.userA.id }, fixture.accountB.apiKey);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("USER_NOT_FOUND");
    expect(await readState(fixture.accountB.id)).toEqual(savedB);
    await expectAccounting(4, 1);
    await expectAccounting(7, 1, fixture.accountB.id);
  });

  it.each([4, 25])("replays a %i-unit decision after replacing the app and all pooled DB connections", async (units) => {
    const payload = { userId: fixture.userA.id, units, requestId: "restart-retry" };
    const first = await postConsume(createTestApp(), payload);
    expect(first.statusCode).toBe(200);
    const saved = await readState();
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
    await testPool.end();
    testPool = new Pool(poolConfig);
    const retry = await postConsume(createTestApp(), payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(await readState()).toEqual(saved);
    await expectAccounting(units === 4 ? 4 : 0, 1);
  });

  it.each([4, 25])("replays October's %i-unit decision in November without creating new-month buckets", async (units) => {
    const payload = { userId: fixture.userA.id, units, requestId: "cross-month-retry" };
    const first = await postConsume(createTestApp(), payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ processedAt: instant, month: "2026-10" });
    const saved = await readState();
    const novemberClock = vi.fn(() => new Date("2026-11-01T00:00:01.000Z"));
    const app = createTestApp({ clock: novemberClock });
    const retry = await postConsume(app, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(novemberClock).not.toHaveBeenCalled();
    expect(await readState()).toEqual(saved);
    // A new ID uses the new month, showing the clock seam really moved forward.
    const newAttempt = await postConsume(app, { ...payload, units: 1, requestId: "november-new" });
    expect(newAttempt.statusCode).toBe(200);
    expect(newAttempt.json()).toMatchObject({ accepted: true, month: "2026-11", user: { consumed: 1 } });
    expect(novemberClock).toHaveBeenCalledTimes(1);
    await expectAccounting((units === 4 ? 4 : 0) + 1, 2);
  });

  it("recovers one durable result when the caller discards the response after commit", async () => {
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 4, requestId: "lost-response" };
    // Model transport loss: the caller retains no response body from this attempt.
    expect((await postConsume(app, payload)).statusCode).toBe(200);
    const saved = await readState();
    const stored = await testPool.query<{ response: ConsumptionDecision }>(
      "SELECT decision_snapshot->'response' AS response FROM request_decisions WHERE account_id = $1 AND request_id = $2",
      [fixture.accountA.id, payload.requestId]
    );
    expect(stored.rows).toHaveLength(1); // Confirmed committed, before the retry.
    const retry = await postConsume(app, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(stored.rows[0]!.response);
    expect(await readState()).toEqual(saved);
    await expectAccounting(4, 1);
  });

  it("does not reserve IDs for validation, authentication, or ownership failures", async () => {
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 4, requestId: "not-reserved" };
    expect((await postConsume(app, { ...payload, units: 0 })).statusCode).toBe(400);
    expect((await postConsume(app, payload, null)).statusCode).toBe(401);
    expect((await postConsume(app, payload, "invalid-key")).statusCode).toBe(401);
    expect((await postConsume(app, { ...payload, userId: fixture.userB.id })).statusCode).toBe(404);
    expect((await postConsume(app, { ...payload, userId: randomUUID() })).statusCode).toBe(404);
    expect(await readState()).toEqual({ accounts: [], users: [], decisions: [] });
    const first = await postConsume(app, payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toBe(true);
    const saved = await readState();
    // Even a used ID must still pass authentication and validation on every call.
    expect((await postConsume(app, payload, null)).statusCode).toBe(401);
    expect((await postConsume(app, { ...payload, units: "4" })).statusCode).toBe(400);
    expect(await readState()).toEqual(saved);
    await expectAccounting(4, 1);
  });

  it("treats differently cased request IDs as independent exact identifiers", async () => {
    const app = createTestApp();
    for (const requestId of ["Action-1", "action-1"]) {
      const response = await postConsume(app, { userId: fixture.userA.id, units: 4, requestId });
      expect(response.statusCode).toBe(200);
      expect(response.json().accepted).toBe(true);
    }
    await expectAccounting(8, 2);
  });

  it("enforces the database unique key even for another user in another month", async () => {
    const app = createTestApp();
    const payload = { userId: fixture.userA.id, units: 4, requestId: "database-unique" };
    expect((await postConsume(app, payload)).statusCode).toBe(200);
    const secondUser = await createUser(testPool, fixture.accountA.id);
    const saved = await readState();
    await expect(testPool.query(
      `INSERT INTO request_decisions (
         account_id, request_id, user_id, requested_units, processed_at, processed_month,
         accepted, decision_reason, blocking_rule, blocking_scope, account_plan_id,
         user_plan_id, account_plan_revision, user_plan_revision, decision_snapshot
       )
       SELECT account_id, request_id, $3::uuid, requested_units,
              '2026-11-01T00:00:01Z'::timestamptz, '2026-11-01'::date,
              accepted, decision_reason, blocking_rule, blocking_scope, account_plan_id,
              user_plan_id, account_plan_revision, user_plan_revision, decision_snapshot
       FROM request_decisions WHERE account_id = $1 AND request_id = $2`,
      [fixture.accountA.id, payload.requestId, secondUser.id]
    )).rejects.toMatchObject({ code: "23505", constraint: "request_decisions_pkey" });
    expect(await readState()).toEqual(saved);
    await expectAccounting(4, 1);
  });
});
