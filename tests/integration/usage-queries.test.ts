import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan, updateCustomPlan } from "../../src/modules/plans/service.js";
import { type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { readAccountUsage, readUserUsage } from "../../src/modules/usage/queries.js";
import { createUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for usage query tests.");

const schemaName = `usage_queries_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const testPool = new Pool({
  connectionString: databaseUrl,
  max: 6,
  connectionTimeoutMillis: 3_000,
  options: `-c search_path=${schemaName} -c timezone=Pacific/Honolulu -c statement_timeout=5000`
});
const pepper = "usage-query-test-pepper";
const apps: FastifyInstance[] = [];
let fixture: TwoAccountFixture;
let instant = "2026-10-31T23:59:59Z";
const clock = () => new Date(instant);

function createTestApp(consumeOptions: ConsumeOptions = {}): FastifyInstance {
  const app = buildApp({
    ...createAppOperations(testPool, pepper, { clock, ...consumeOptions }),
    logger: false
  });
  apps.push(app);
  return app;
}

function get(app: FastifyInstance, url: string, key = fixture.accountA.apiKey) {
  return app.inject({ method: "GET", url, headers: { "x-api-key": key } });
}

async function usage(app: FastifyInstance, url = `/users/${fixture.userA.id}/usage`) {
  const response = await get(app, url);
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function charge(app: FastifyInstance, units: number, userId = fixture.userA.id) {
  const response = await app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { userId, units, requestId: randomUUID() }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().accepted).toBe(true);
}

async function accountingState() {
  const state = await testPool.query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY account_id, usage_month), '[]') FROM account_monthly_usage a) AS accounts,
      (SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY user_id, usage_month), '[]') FROM user_monthly_usage u) AS users,
      (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY account_id, request_id), '[]') FROM request_decisions d) AS decisions
  `);
  return state.rows[0];
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  instant = "2026-10-31T23:59:59Z";
  await testPool.query(`
    DELETE FROM request_decisions;
    DELETE FROM user_monthly_usage;
    DELETE FROM account_monthly_usage;
    DELETE FROM users;
    UPDATE accounts SET account_plan_id = 1;
    DELETE FROM plans WHERE owner_account_id IS NOT NULL;
    DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(testPool, pepper);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminPool.end();
});

describe("authenticated monthly usage queries", () => {
  it("defaults unused subjects to the current UTC month with zero consumption and no writes", async () => {
    const app = createTestApp();
    const before = await accountingState();
    expect(await usage(app, "/usage")).toEqual({
      month: "2026-10", isCurrentMonth: true,
      account: { id: fixture.accountA.id, consumed: 0, monthlyLimit: 10_000, remaining: 10_000 }
    });
    expect(await usage(app)).toEqual({
      month: "2026-10", isCurrentMonth: true,
      account: { id: fixture.accountA.id, consumed: 0, monthlyLimit: 10_000, remaining: 10_000 },
      user: { id: fixture.userA.id, consumed: 0, monthlyLimit: 1_000, remaining: 1_000 }
    });
    expect(await accountingState()).toEqual(before);
  });

  it("keeps October's four units while November starts at zero and then reaches three", async () => {
    const app = createTestApp();
    await charge(app, 4);
    expect(await usage(app)).toMatchObject({ month: "2026-10", account: { consumed: 4 }, user: { consumed: 4 } });
    instant = "2026-11-01T00:00:00Z";
    expect(await usage(app)).toMatchObject({ month: "2026-11", isCurrentMonth: true, account: { consumed: 0 }, user: { consumed: 0 } });
    await charge(app, 3);
    const before = await accountingState();
    expect(await usage(app, `/users/${fixture.userA.id}/usage?month=2026-10`)).toEqual({
      month: "2026-10", isCurrentMonth: false,
      account: { id: fixture.accountA.id, consumed: 4 }, user: { id: fixture.userA.id, consumed: 4 }
    });
    expect(await usage(app, "/usage?month=2026-10")).toEqual({
      month: "2026-10", isCurrentMonth: false, account: { id: fixture.accountA.id, consumed: 4 }
    });
    const current = await usage(app);
    expect(current).toMatchObject({ month: "2026-11", account: { consumed: 3, remaining: 9_997 }, user: { consumed: 3, remaining: 997 } });
    expect(await usage(app, `/users/${fixture.userA.id}/usage?month=2026-11`)).toEqual(current);
    expect(await usage(app, "/usage?month=2026-11")).toEqual({
      month: "2026-11", isCurrentMonth: true, account: current.account
    });
    expect(await accountingState()).toEqual(before);
  });

  it("reports eleven account units and separate four/seven-unit users sharing one plan", async () => {
    const app = createTestApp();
    const second = await createUser(testPool, fixture.accountA.id);
    expect(second.plan.id).toBe(fixture.userA.plan.id);
    await charge(app, 4);
    await charge(app, 7, second.id);
    expect(await usage(app, "/usage")).toMatchObject({ account: { consumed: 11, remaining: 9_989 } });
    expect(await usage(app)).toMatchObject({ account: { consumed: 11 }, user: { consumed: 4, remaining: 996 } });
    expect(await usage(app, `/users/${second.id}/usage`)).toMatchObject({ account: { consumed: 11 }, user: { consumed: 7, remaining: 993 } });
    expect((await get(app, "/usage", fixture.accountB.apiKey)).json()).toMatchObject({
      account: { id: fixture.accountB.id, consumed: 0, monthlyLimit: 100_000 }
    });
  });

  it.each(["account", "user"] as const)("clamps remaining after a %s plan downgrade and leaves usage and decisions unchanged", async (scope) => {
    const plan = await createCustomPlan(testPool, fixture.accountA.id, {
      name: "Mutable allowance", scope, monthlyLimit: 10, requestLimit: 100
    });
    if (scope === "account") await assignAccountPlan(testPool, fixture.accountA.id, plan.id);
    else await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, plan.id);
    const app = createTestApp();
    await charge(app, 4);
    const before = await accountingState();
    const update = await app.inject({
      method: "PATCH", url: `/plans/${plan.id}`, headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { monthlyLimit: 2 }
    });
    expect(update.statusCode).toBe(200);
    expect(await usage(app)).toMatchObject({ [scope]: { consumed: 4, monthlyLimit: 2, remaining: 0 } });
    if (scope === "account") expect(await usage(app, "/usage")).toMatchObject({ account: { consumed: 4, monthlyLimit: 2, remaining: 0 } });
    await updateCustomPlan(testPool, fixture.accountA.id, plan.id, { monthlyLimit: 0 });
    expect(await usage(app)).toMatchObject({ [scope]: { consumed: 4, monthlyLimit: 0, remaining: 0 } });
    instant = "2026-11-01T00:00:00Z";
    expect(await usage(app, `/users/${fixture.userA.id}/usage?month=2026-10`)).toEqual({
      month: "2026-10", isCurrentMonth: false,
      account: { id: fixture.accountA.id, consumed: 4 }, user: { id: fixture.userA.id, consumed: 4 }
    });
    expect(await accountingState()).toEqual(before);
  });

  it("uses the newly assigned plan without resetting consumed units", async () => {
    const app = createTestApp();
    await charge(app, 4);
    const accountPlan = await createCustomPlan(testPool, fixture.accountA.id, {
      name: "Replacement account", scope: "account", monthlyLimit: 20, requestLimit: 10
    });
    await assignAccountPlan(testPool, fixture.accountA.id, accountPlan.id);
    await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, fixture.customPlanA.id);
    expect(await usage(app)).toMatchObject({
      account: { consumed: 4, monthlyLimit: 20, remaining: 16 },
      user: { consumed: 4, monthlyLimit: 50, remaining: 46 }
    });
  });

  it.each(["2026-13", "2026-00", "2026-1", "26-10", "0000-01", "10000-01", "2026-10-01", "", "2026-10%0A", "%202026-10", "2026-10%27%3BSELECT%201"])("rejects invalid month %s without writes or SQL details", async (month) => {
    const app = createTestApp();
    const before = await accountingState();
    for (const path of ["/usage", `/users/${fixture.userA.id}/usage`]) {
      const response = await get(app, `${path}?month=${month}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toEqual({ code: "INVALID_REQUEST", message: "Query parameters are invalid." });
    }
    expect(await accountingState()).toEqual(before);
  });

  it("rejects duplicate month values and ownership/time overrides", async () => {
    const app = createTestApp();
    for (const query of ["month=2026-10&month=2026-11", `accountId=${fixture.accountB.id}`, "clock=2026-11-01", "month[year]=2026"]) {
      for (const path of ["/usage", `/users/${fixture.userA.id}/usage`]) {
        const response = await get(app, `${path}?${query}`);
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("INVALID_REQUEST");
      }
    }
  });

  it("accepts the supported year bounds and returns only consumed units for noncurrent months", async () => {
    const app = createTestApp();
    for (const month of ["0001-01", "2026-09", "2026-11", "9999-12"]) {
      expect(await usage(app, `/users/${fixture.userA.id}/usage?month=${month}`)).toEqual({
        month, isCurrentMonth: false,
        account: { id: fixture.accountA.id, consumed: 0 }, user: { id: fixture.userA.id, consumed: 0 }
      });
    }
  });

  it("authenticates both routes before validating or revealing tenant data", async () => {
    const app = createTestApp();
    for (const url of ["/usage?month=2026-13", `/users/${fixture.userA.id}/usage`]) {
      for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": `umq_${"a".repeat(43)}` }]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("UNAUTHORIZED");
        expect(response.body).not.toContain(fixture.accountA.id);
      }
    }
  });

  it("hides foreign users exactly like unknown or malformed user IDs", async () => {
    const app = createTestApp();
    await charge(app, 4);
    const before = await accountingState();
    for (const id of [fixture.userB.id, randomUUID(), "not-a-uuid", "x%27OR%271%27%3D%271"]) {
      for (const suffix of ["", "?month=2026-09"]) {
        const response = await get(app, `/users/${id}/usage${suffix}`);
        expect(response.statusCode).toBe(404);
        expect(response.json().error).toEqual({ code: "USER_NOT_FOUND", message: "User not found." });
        expect(response.body).not.toContain(fixture.accountB.id);
        expect(response.json()).not.toHaveProperty("account");
      }
    }
    const reverse = await get(app, `/users/${fixture.userA.id}/usage`, fixture.accountB.apiKey);
    expect(reverse.statusCode).toBe(404);
    expect(await accountingState()).toEqual(before);
  });

  it("reads committed paired totals while consumption is paused between its two increments", async () => {
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = createTestApp({ testHooks: { afterAccountIncrement: async () => { entered(); await gate; } } });
    await app.ready();
    const pending = charge(app, 4);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        paused,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Consumption did not reach the gate.")), 3_000); })
      ]);
      expect(await usage(app)).toMatchObject({ account: { consumed: 0 }, user: { consumed: 0 } });
      expect(await usage(app, "/usage")).toMatchObject({ account: { consumed: 0 } });
    } finally {
      clearTimeout(timer);
      release();
      await pending;
    }
    expect(await usage(app)).toMatchObject({ account: { consumed: 4 }, user: { consumed: 4 } });
  });

  it("uses UTC with offset clocks and a non-UTC database session, calling the clock once", async () => {
    let calls = 0;
    const options = { clock: () => { calls += 1; return new Date("2026-11-01T01:30:00+03:00"); } };
    expect(await readUserUsage(testPool, fixture.accountA.id, fixture.userA.id, undefined, options)).toMatchObject({
      month: "2026-10", isCurrentMonth: true
    });
    expect(calls).toBe(1);
    const actualMonth = (await testPool.query<{ month: string }>(
      "SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM') AS month"
    )).rows[0]!.month;
    expect(await readAccountUsage(testPool, fixture.accountA.id)).toMatchObject({ month: actualMonth, isCurrentMonth: true });
  });
});
