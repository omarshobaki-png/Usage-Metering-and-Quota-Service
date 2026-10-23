import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDemoScenario } from "../../demo/client.js";
import { createDemoFixture } from "../../demo/setup.js";
import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for demo-client tests.");
}

const schemaName = `demo_client_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const pool = new Pool({
  connectionString: databaseUrl,
  max: 8,
  options: `-c search_path=${schemaName} -c statement_timeout=5000`
});
const pepper = "demo-client-integration-pepper";
const instant = "2026-10-18T08:00:00.000Z";
const clock = () => new Date(instant);
let app: FastifyInstance;
let serviceUrl: string;

function createDemoApp(): FastifyInstance {
  return buildApp({
    ...createAppOperations(pool, pepper, { clock }),
    logger: false
  });
}

async function accountState(accountId: string) {
  return (
    await pool.query<{
      decisionCount: string;
      acceptedUnits: number;
      accountConsumed: number;
      userConsumed: number;
    }>(
      `
        SELECT
          (SELECT count(*) FROM request_decisions WHERE account_id = $1) AS "decisionCount",
          (SELECT COALESCE(sum(requested_units), 0)::integer
             FROM request_decisions WHERE account_id = $1 AND accepted) AS "acceptedUnits",
          (SELECT COALESCE(sum(consumed_units), 0)::integer
             FROM account_monthly_usage WHERE account_id = $1) AS "accountConsumed",
          (SELECT COALESCE(sum(consumed_units), 0)::integer
             FROM user_monthly_usage WHERE account_id = $1) AS "userConsumed"
      `,
      [accountId]
    )
  ).rows[0]!;
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
  app = createDemoApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  serviceUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminPool.end();
});

describe("example client", () => {
  it("runs the fixed HTTP scenario, performs work only on acceptance, and reruns on a fresh fixture", async () => {
    const first = await createDemoFixture(pool, {
      serviceUrl,
      apiKeyPepper: pepper,
      accountName: "Demo One"
    });
    const firstLog: string[] = [];
    const processed: { user: string; units: number }[] = [];
    const firstRun = await runDemoScenario(first.config, {
      log: (line) => firstLog.push(line),
      processDocument: (user, units) => {
        processed.push({ user, units });
      }
    });

    expect(firstRun.newDecisions.map((decision) => decision.accepted)).toEqual([
      true,
      false,
      true,
      false,
      true
    ]);
    expect(firstRun.newDecisions[1]?.blockedBy).toEqual({
      scope: "user",
      rule: "max_units_per_request",
      limit: 5
    });
    expect(firstRun.newDecisions[3]?.blockedBy).toEqual({
      scope: "account",
      rule: "monthly_limit",
      limit: 30
    });
    expect(firstRun.replay).toEqual(firstRun.newDecisions[3]);
    expect(firstRun.liveUsage).toMatchObject({
      month: "2026-10",
      account: { consumed: 31, monthlyLimit: 50, remaining: 19 },
      user: { consumed: 27, monthlyLimit: 30, remaining: 3 }
    });
    expect(processed).toEqual([
      { user: "Basic", units: 4 },
      { user: "Premium", units: 20 },
      { user: "Premium", units: 7 }
    ]);
    expect(firstLog.join("\n")).not.toContain(first.config.apiKey);
    expect(await accountState(first.accountId)).toEqual({
      decisionCount: "5",
      acceptedUnits: 31,
      accountConsumed: 31,
      userConsumed: 31
    });

    const second = await createDemoFixture(pool, {
      serviceUrl,
      apiKeyPepper: pepper,
      accountName: "Demo Two"
    });
    expect(second.accountId).not.toBe(first.accountId);
    await runDemoScenario(second.config, { log: () => undefined });
    expect(await accountState(second.accountId)).toEqual({
      decisionCount: "5",
      acceptedUnits: 31,
      accountConsumed: 31,
      userConsumed: 31
    });
    expect(await accountState(first.accountId)).toEqual({
      decisionCount: "5",
      acceptedUnits: 31,
      accountConsumed: 31,
      userConsumed: 31
    });
  });
});
