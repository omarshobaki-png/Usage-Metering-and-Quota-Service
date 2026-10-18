import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan } from "../../src/modules/plans/service.js";
import { consume, type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { consumptionDecisionSchema, type ConsumeRequest, type ConsumptionDecision } from "../../src/modules/usage/contract.js";
import { parseConsumptionSnapshot } from "../../src/modules/usage/snapshot.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for rollover tests.");

const testId = randomUUID().replaceAll("-", "");
const schemaName = `rollover_${process.pid}_${testId}`;
const quotedSchemaName = `"${schemaName}"`;
const applicationName = `rollover_${testId}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const testPool = new Pool({
  connectionString: databaseUrl, max: 6, application_name: applicationName,
  connectionTimeoutMillis: 5_000,
  // A non-UTC database session must not affect the service's accounting month.
  options: `-c search_path=${schemaName} -c timezone=Pacific/Honolulu -c statement_timeout=12000 -c lock_timeout=10000`
});
const october = "2026-10-31T23:59:59.999Z";
const november = "2026-11-01T00:00:00.000Z";
const testPepper = "month-rollover-test-pepper";
const apps: FastifyInstance[] = [];
let currentInstant = october;
let fixture: TwoAccountFixture;

function createTestApp(options: ConsumeOptions = {}): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => { await testPool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(testPool, testPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(testPool, accountId, input),
      getUser: async (accountId, userId) => getUser(testPool, accountId, userId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(testPool, accountId, input, {
        clock: () => new Date(currentInstant), ...options
      })
    },
    logger: false
  });
  apps.push(app);
  return app;
}

async function postConsume(app: FastifyInstance, units: number, requestId: string, userId = fixture.userA.id) {
  const payload: ConsumeRequest = { userId, units, requestId };
  const response = await app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey }, payload
  });
  if (response.statusCode === 200) {
    const body = consumptionDecisionSchema.parse(response.json());
    const saved = await testPool.query<{
      snapshot: unknown; processedAt: Date; month: string; units: number; accepted: boolean;
    }>(
      `SELECT decision_snapshot AS snapshot, processed_at AS "processedAt",
              to_char(processed_month,'YYYY-MM') AS month, requested_units AS units, accepted
       FROM request_decisions WHERE account_id = $1 AND request_id = $2`,
      [fixture.accountA.id, requestId]
    );
    expect(saved.rows).toHaveLength(1);
    const row = saved.rows[0]!;
    expect(parseConsumptionSnapshot(row.snapshot).response).toEqual(body);
    expect(row.processedAt.toISOString()).toBe(body.processedAt);
    expect(row.month).toBe(body.month);
    expect(row.units).toBe(units);
    expect(row.accepted).toBe(body.accepted);
  }
  return response;
}

// Compare every persisted field, including updated_at and complete decision rows.
async function readState(month: string | null = null) {
  const accounts = await testPool.query(
    `SELECT to_jsonb(t) AS row FROM account_monthly_usage t
     WHERE account_id = $1 AND ($2::date IS NULL OR usage_month = $2::date) ORDER BY usage_month`,
    [fixture.accountA.id, month]
  );
  const users = await testPool.query(
    `SELECT to_jsonb(t) AS row FROM user_monthly_usage t
     WHERE account_id = $1 AND ($2::date IS NULL OR usage_month = $2::date) ORDER BY user_id, usage_month`,
    [fixture.accountA.id, month]
  );
  const decisions = await testPool.query(
    `SELECT to_jsonb(t) AS row FROM request_decisions t
     WHERE account_id = $1 AND ($2::date IS NULL OR processed_month = $2::date) ORDER BY request_id`,
    [fixture.accountA.id, month]
  );
  return { accounts: accounts.rows, users: users.rows, decisions: decisions.rows };
}

async function expectBuckets(expected: { month: string; consumed: number }[], decisionCount: number) {
  const accounts = await testPool.query<{ month: string; consumed: number }>(
    `SELECT to_char(usage_month,'YYYY-MM') AS month, consumed_units AS consumed
     FROM account_monthly_usage WHERE account_id = $1 ORDER BY usage_month`, [fixture.accountA.id]
  );
  const users = await testPool.query<{ month: string; consumed: number }>(
    `SELECT to_char(usage_month,'YYYY-MM') AS month, consumed_units AS consumed
     FROM user_monthly_usage WHERE account_id = $1 AND user_id = $2 ORDER BY usage_month`,
    [fixture.accountA.id, fixture.userA.id]
  );
  expect(accounts.rows).toEqual(expected);
  expect(users.rows).toEqual(expected);
  const decisions = await testPool.query<{ count: number }>(
    "SELECT COUNT(*)::integer AS count FROM request_decisions WHERE account_id = $1", [fixture.accountA.id]
  );
  expect(decisions.rows[0]!.count).toBe(decisionCount);
  const mismatches = await testPool.query(`
    SELECT a.usage_month FROM account_monthly_usage a WHERE a.account_id = $1 AND (
      a.consumed_units <> (SELECT COALESCE(SUM(u.consumed_units),0) FROM user_monthly_usage u
                          WHERE u.account_id = a.account_id AND u.usage_month = a.usage_month)
      OR a.consumed_units <> (SELECT COALESCE(SUM(d.requested_units),0) FROM request_decisions d
                             WHERE d.account_id = a.account_id AND d.processed_month = a.usage_month AND d.accepted)
    )
  `, [fixture.accountA.id]);
  expect(mismatches.rows).toEqual([]);
  const userMismatches = await testPool.query(`
    SELECT u.user_id, u.usage_month FROM user_monthly_usage u WHERE u.account_id = $1
    AND u.consumed_units <> (SELECT COALESCE(SUM(d.requested_units),0) FROM request_decisions d
                            WHERE d.account_id = u.account_id AND d.user_id = u.user_id
                              AND d.processed_month = u.usage_month AND d.accepted)
  `, [fixture.accountA.id]);
  expect(userMismatches.rows).toEqual([]);
}

async function waitForAccountLock(holderPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await testPool.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1
       AND wait_event_type = 'Lock' AND $2 = ANY(pg_blocking_pids(pid))) AS waiting`,
      [applicationName, holderPid]
    );
    if (result.rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Rollover request did not wait for the held account lock.");
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  currentInstant = october;
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
  currentInstant = october;
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("UTC month rollover through POST /consume", () => {
  it("keeps October's 4 units and November's 3 units in independent buckets at exact midnight", async () => {
    const app = createTestApp();
    const first = await postConsume(app, 4, "october-4");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ accepted: true, processedAt: october, month: "2026-10" });
    const savedOctober = await readState("2026-10-01");
    currentInstant = november;
    const next = await postConsume(app, 3, "november-3");
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ accepted: true, processedAt: november, month: "2026-11",
      account: { consumed: 3, remaining: 9_997 }, user: { consumed: 3, remaining: 997 }
    });
    expect(await readState("2026-10-01")).toEqual(savedOctober);
    await expectBuckets([{ month: "2026-10", consumed: 4 }, { month: "2026-11", consumed: 3 }], 2);
  });

  it("restores available monthly allowance without clearing the exhausted previous month", async () => {
    for (const scope of ["account", "user"] as const) {
      const plan = await createCustomPlan(testPool, fixture.accountA.id, {
        name: `Four-unit ${scope}`, scope, monthlyLimit: 4, requestLimit: 100
      });
      if (scope === "account") await assignAccountPlan(testPool, fixture.accountA.id, plan.id);
      else await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, plan.id);
    }
    const app = createTestApp();
    const full = await postConsume(app, 4, "october-full");
    expect(full.statusCode).toBe(200);
    expect(full.json()).toMatchObject({ accepted: true, account: { remaining: 0 }, user: { remaining: 0 } });
    const denied = await postConsume(app, 1, "october-exhausted");
    expect(denied.statusCode).toBe(200);
    expect(denied.json().accepted).toBe(false);
    const savedOctober = await readState("2026-10-01");
    currentInstant = november;
    const fresh = await postConsume(app, 3, "november-fresh");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ accepted: true,
      account: { consumed: 3, remaining: 1 }, user: { consumed: 3, remaining: 1 }
    });
    expect(await readState("2026-10-01")).toEqual(savedOctober);
    await expectBuckets([{ month: "2026-10", consumed: 4 }, { month: "2026-11", consumed: 3 }], 3);
  });

  it.each([4, 25])("replays an October %i-unit outcome before and after November usage without any writes", async (units) => {
    const clock = vi.fn(() => new Date(currentInstant));
    const app = createTestApp({ clock });
    const first = await postConsume(app, units, "historical-id");
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toBe(units === 4);
    expect(clock).toHaveBeenCalledTimes(1);
    const savedOctober = await readState();
    currentInstant = november;
    clock.mockClear();
    const replay = await postConsume(app, units, "historical-id");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(clock).not.toHaveBeenCalled();
    expect(await readState()).toEqual(savedOctober);
    expect(await readState("2026-11-01")).toEqual({ accounts: [], users: [], decisions: [] });
    const fresh = await postConsume(app, 3, "new-month-id");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ accepted: true, month: "2026-11", account: { consumed: 3 }, user: { consumed: 3 } });
    const savedBoth = await readState();
    clock.mockClear();
    expect((await postConsume(app, units, "historical-id")).json()).toEqual(first.json());
    expect(clock).not.toHaveBeenCalled();
    expect(await readState()).toEqual(savedBoth);
    await expectBuckets([{ month: "2026-10", consumed: units === 4 ? 4 : 0 }, { month: "2026-11", consumed: 3 }], 2);
  });

  it.each(["units", "user"] as const)("keeps IDs reserved across months for a changed %s payload", async (field) => {
    const second = await createUser(testPool, fixture.accountA.id);
    const app = createTestApp();
    expect((await postConsume(app, 4, "reserved-across-months")).statusCode).toBe(200);
    const saved = await readState();
    currentInstant = november;
    const conflict = await postConsume(app, field === "units" ? 5 : 4, "reserved-across-months",
      field === "user" ? second.id : fixture.userA.id);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("REQUEST_ID_CONFLICT");
    expect(await readState()).toEqual(saved);
    await expectBuckets([{ month: "2026-10", consumed: 4 }], 1);
  });

  it.each([3, 25])("puts a waiting %i-unit request entirely in November after acquiring its lock", async (units) => {
    const clock = vi.fn(() => new Date(currentInstant));
    const app = createTestApp({ clock });
    expect((await postConsume(app, 4, "before-wait")).statusCode).toBe(200);
    const savedOctober = await readState("2026-10-01");
    clock.mockClear();
    const holder = await testPool.connect();
    let pending: Promise<PromiseSettledResult<LightMyRequestResponse>[]> = Promise.resolve([]);
    let results: PromiseSettledResult<LightMyRequestResponse>[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [fixture.accountA.id]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      pending = Promise.allSettled([postConsume(app, units, "wait-across-midnight")]);
      await waitForAccountLock(holderPid);
      expect(clock).not.toHaveBeenCalled();
      expect(currentInstant).toBe(october);
      currentInstant = november;
    } finally {
      try {
        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        results = await pending;
      }
    }
    const result = results[0]!;
    if (result.status === "rejected") throw result.reason;
    expect(result.value.statusCode).toBe(200);
    expect(result.value.json()).toMatchObject({ accepted: units === 3, processedAt: november, month: "2026-11" });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(await readState("2026-10-01")).toEqual(savedOctober);
    await expectBuckets([{ month: "2026-10", consumed: 4 }, { month: "2026-11", consumed: units === 3 ? 3 : 0 }], 2);
  }, 20_000);

  it("captures time once even if midnight passes between the account and user writes", async () => {
    const clock = vi.fn(() => new Date(currentInstant));
    const app = createTestApp({ clock, testHooks: {
      afterAccountIncrement: () => { currentInstant = november; }
    } });
    const first = await postConsume(app, 4, "single-accounting-instant");
    expect(first.statusCode).toBe(200);
    expect(currentInstant).toBe(november); // Response/commit is on the other side of the simulated boundary.
    expect(clock).toHaveBeenCalledTimes(1);
    expect(first.json()).toMatchObject({ accepted: true, processedAt: october, month: "2026-10" });
    await expectBuckets([{ month: "2026-10", consumed: 4 }], 1);
    const savedOctober = await readState("2026-10-01");
    const next = await postConsume(app, 3, "next-accounting-instant");
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ accepted: true, processedAt: november, month: "2026-11" });
    expect(clock).toHaveBeenCalledTimes(2);
    expect(await readState("2026-10-01")).toEqual(savedOctober);
    await expectBuckets([{ month: "2026-10", consumed: 4 }, { month: "2026-11", consumed: 3 }], 2);
  });

  it("keeps December and January separate across the year boundary", async () => {
    const app = createTestApp();
    currentInstant = "2026-12-31T23:59:59.999Z";
    const december = await postConsume(app, 4, "december-4");
    expect(december.statusCode).toBe(200);
    expect(december.json().month).toBe("2026-12");
    const savedDecember = await readState("2026-12-01");
    currentInstant = "2027-01-01T00:00:00.000Z";
    const january = await postConsume(app, 3, "january-3");
    expect(january.statusCode).toBe(200);
    expect(january.json()).toMatchObject({ accepted: true, processedAt: currentInstant, month: "2027-01" });
    expect((await postConsume(app, 4, "december-4")).json()).toEqual(december.json());
    expect(await readState("2026-12-01")).toEqual(savedDecember);
    await expectBuckets([{ month: "2026-12", consumed: 4 }, { month: "2027-01", consumed: 3 }], 2);
  });

  it.each([
    ["2026-11-01T01:30:00+03:00", "2026-10-31T22:30:00.000Z", "2026-10"],
    ["2026-10-31T23:30:00-02:00", "2026-11-01T01:30:00.000Z", "2026-11"]
  ])("uses the UTC instant of %s, not the displayed local month", async (instant, normalized, month) => {
    currentInstant = instant;
    const response = await postConsume(createTestApp(), 4, "timezone-offset");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, processedAt: normalized, month });
    await expectBuckets([{ month, consumed: 4 }], 1);
  });
});
