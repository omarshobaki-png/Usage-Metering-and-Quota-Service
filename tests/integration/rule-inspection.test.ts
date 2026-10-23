import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for rule inspection tests.");
const schemaName = `rule_inspection_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 3_000,
  options: `-c search_path=${schemaName} -c timezone=Pacific/Honolulu -c statement_timeout=5000`
});
const pepper = "rule-inspection-test-pepper";
let fixture: TwoAccountFixture;
let instant = "2026-10-31T23:59:59Z";
const clock = () => new Date(instant);
const apps: FastifyInstance[] = [];

function createTestApp(options: ConsumeOptions = {}) {
  const app = buildApp({
    ...createAppOperations(pool, pepper, { clock, ...options }),
    logger: false
  });
  apps.push(app);
  return app;
}

async function get(app: FastifyInstance, url: string, status = 200, key = fixture.accountA.apiKey) {
  const response = await app.inject({ method: "GET", url, headers: { "x-api-key": key } });
  expect(response.statusCode).toBe(status);
  return response.json();
}

async function write(app: FastifyInstance, method: "POST" | "PATCH", url: string, payload: Record<string, unknown>, status = 200) {
  const response = await app.inject({ method, url, payload, headers: { "x-api-key": fixture.accountA.apiKey } });
  expect(response.statusCode).toBe(status);
  return response.json();
}

function spend(app: FastifyInstance, units: number, requestId: string = randomUUID()) {
  return write(app, "POST", "/consume", { userId: fixture.userA.id, units, requestId });
}

async function savedDecision(requestId: string) {
  return (await pool.query(
    "SELECT to_jsonb(d) AS row FROM request_decisions d WHERE account_id = $1 AND request_id = $2",
    [fixture.accountA.id, requestId]
  )).rows[0]?.row;
}

async function state() {
  const result: Record<string, unknown> = {};
  for (const table of ["accounts", "users", "plans", "account_monthly_usage", "user_monthly_usage", "request_decisions"]) {
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
});
beforeEach(async () => {
  instant = "2026-10-31T23:59:59Z";
  await pool.query(`
    DELETE FROM request_decisions; DELETE FROM user_monthly_usage; DELETE FROM account_monthly_usage;
    DELETE FROM users; UPDATE accounts SET account_plan_id = 1;
    DELETE FROM plans WHERE owner_account_id IS NOT NULL; DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(pool, pepper);
});
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => app.close())); });
afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminPool.end();
});

describe("current applied-rule inspection", () => {
  it("shows complete assigned rules and zero-bucket allowances without modifying state", async () => {
    const app = createTestApp();
    const before = await state();
    const accountDetail = (await get(app, "/account")).account;
    const userDetail = (await get(app, `/users/${fixture.userA.id}`)).user;
    const result = await get(app, `/users/${fixture.userA.id}/rules`);
    expect(result).toEqual({
      month: "2026-10",
      account: { id: fixture.accountA.id, consumed: 0, remaining: 10_000, plan: {
        id: 1, name: "Starter", scope: "account", monthlyLimit: 10_000, maxUnitsPerRequest: 100, revision: 1
      } },
      user: { id: fixture.userA.id, consumed: 0, remaining: 1_000, plan: {
        id: 3, name: "Basic", scope: "user", monthlyLimit: 1_000, maxUnitsPerRequest: 20, revision: 1
      } }
    });
    expect(result.account.plan).toEqual(accountDetail.plan);
    expect(result.user.plan).toEqual(userDetail.plan);
    expect(await get(app, "/account/rules")).toEqual({ month: "2026-10", account: result.account });
    expect(await state()).toEqual(before);
  });

  it("updates one shared plan immediately while users keep usage of four and zero and old decisions stay historical", async () => {
    const app = createTestApp();
    const plan = (await write(app, "POST", "/plans", {
      name: "Shared", scope: "user", monthlyLimit: 10, requestLimit: 5
    }, 201)).plan;
    await write(app, "PATCH", `/users/${fixture.userA.id}/plan`, { planId: plan.id });
    const second = (await write(app, "POST", "/users", { planId: plan.id }, 201)).user;
    const original = await spend(app, 4, "before-shared-edit");
    const saved = await savedDecision("before-shared-edit");
    expect(saved.decision_snapshot.evaluatedLimits.user).toEqual({ monthlyLimit: 10, maxUnitsPerRequest: 5 });
    await write(app, "PATCH", `/plans/${plan.id}`, { name: "Shared updated", monthlyLimit: 20, requestLimit: 10 });
    for (const [userId, consumed] of [[fixture.userA.id, 4], [second.id, 0]] as const) {
      const inspection = await get(app, `/users/${userId}/rules`);
      const detail = (await get(app, `/users/${userId}`)).user;
      expect(inspection.user).toEqual({ id: userId, consumed, remaining: 20 - consumed, plan: {
        id: plan.id, name: "Shared updated", scope: "user", monthlyLimit: 20, maxUnitsPerRequest: 10, revision: 2
      } });
      expect(detail.plan).toEqual(inspection.user.plan);
      expect(inspection.account.consumed).toBe(4);
      expect(await get(app, `/users/${userId}/usage`)).toMatchObject({ user: { consumed, remaining: 20 - consumed } });
    }
    expect(await spend(app, 4, "before-shared-edit")).toEqual(original);
    expect(await savedDecision("before-shared-edit")).toEqual(saved);
    const fresh = await spend(app, 6);
    expect(fresh).toMatchObject({ accepted: true, user: { plan: { id: plan.id, revision: 2 } } });
  });

  it.each(["account", "user"] as const)("switches the %s assignment live and preserves usage through a switch back to a predefined plan", async (scope) => {
    const app = createTestApp();
    const original = await spend(app, 4, "before-switch");
    const saved = await savedDecision("before-switch");
    const plan = (await write(app, "POST", "/plans", {
      name: "Replacement", scope, monthlyLimit: 8, requestLimit: 2
    }, 201)).plan;
    const assignment = scope === "account" ? "/account/plan" : `/users/${fixture.userA.id}/plan`;
    await write(app, "PATCH", assignment, { planId: plan.id });
    const inspection = await get(app, `/users/${fixture.userA.id}/rules`);
    expect(inspection[scope]).toMatchObject({ consumed: 4, remaining: 4, plan: {
      id: plan.id, scope, monthlyLimit: 8, maxUnitsPerRequest: 2, revision: 1
    } });
    const detail = await get(app, scope === "account" ? "/account" : `/users/${fixture.userA.id}`);
    expect(detail[scope].plan).toEqual(inspection[scope].plan);
    expect(await spend(app, 3)).toMatchObject({ accepted: false, blockedBy: { scope, rule: "max_units_per_request", limit: 2 } });
    expect(await spend(app, 2)).toMatchObject({ accepted: true, [scope]: { consumed: 6, plan: { id: plan.id } } });
    await write(app, "PATCH", assignment, { planId: scope === "account" ? 1 : 3 });
    expect(await get(app, `/users/${fixture.userA.id}/rules`)).toMatchObject({
      [scope]: { consumed: 6, plan: { name: scope === "account" ? "Starter" : "Basic" } }
    });
    expect(await spend(app, 3)).toMatchObject({ accepted: true, [scope]: { consumed: 9 } });
    expect(await spend(app, 4, "before-switch")).toEqual(original);
    expect(await savedDecision("before-switch")).toEqual(saved);
  });

  it("lists and reads only predefined and owned plan definitions, including scope-filtered catalogs", async () => {
    const app = createTestApp();
    const before = await state();
    const catalog = (await get(app, "/plans")).plans;
    expect(catalog.map((plan: { id: number }) => plan.id).sort((a: number, b: number) => a - b))
      .toEqual([1, 2, 3, 4, fixture.customPlanA.id].sort((a, b) => a - b));
    for (const plan of catalog) {
      expect((await get(app, `/plans/${plan.id}`)).plan).toEqual(plan);
      expect(plan).toMatchObject({ name: expect.any(String), monthlyLimit: expect.any(Number), requestLimit: expect.any(Number), revision: 1 });
    }
    for (const scope of ["account", "user"]) {
      const filtered = (await get(app, `/plans?scope=${scope}`)).plans;
      expect(filtered).toEqual(catalog.filter((plan: { scope: string }) => plan.scope === scope));
    }
    expect((await get(app, "/plans", 200, fixture.accountB.apiKey)).plans)
      .not.toContainEqual(expect.objectContaining({ id: fixture.customPlanA.id }));
    expect(await state()).toEqual(before);
  });

  it("rejects foreign plans, foreign-user assignments, wrong scopes and predefined edits without changes", async () => {
    const app = createTestApp();
    await spend(app, 4);
    const before = await state();
    expect((await get(app, `/plans/${fixture.customPlanB.id}`, 404)).error.code).toBe("PLAN_NOT_FOUND");
    expect((await write(app, "PATCH", `/plans/${fixture.customPlanB.id}`, { monthlyLimit: 999 }, 404)).error.code).toBe("PLAN_NOT_FOUND");
    for (const path of ["/account/plan", `/users/${fixture.userA.id}/plan`]) {
      expect((await write(app, "PATCH", path, { planId: fixture.customPlanB.id }, 404)).error.code).toBe("PLAN_NOT_FOUND");
    }
    expect((await write(app, "PATCH", `/users/${fixture.userB.id}/plan`, { planId: fixture.customPlanA.id }, 404)).error.code).toBe("USER_NOT_FOUND");
    expect((await write(app, "PATCH", "/account/plan", { planId: 3 }, 422)).error.code).toBe("PLAN_SCOPE_MISMATCH");
    expect((await write(app, "PATCH", `/users/${fixture.userA.id}/plan`, { planId: 1 }, 422)).error.code).toBe("PLAN_SCOPE_MISMATCH");
    expect((await write(app, "PATCH", "/plans/1", { monthlyLimit: 999 }, 403)).error.code).toBe("PREDEFINED_PLAN_READ_ONLY");
    expect(await state()).toEqual(before);
  });

  it("authenticates both inspection routes before validating queries", async () => {
    const app = createTestApp();
    for (const url of ["/account/rules", `/users/${fixture.userA.id}/rules?month=2026-10`]) {
      for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": `umq_${"a".repeat(43)}` }]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("UNAUTHORIZED");
      }
    }
  });

  it("returns the same safe 404 for foreign, missing and malformed users", async () => {
    const app = createTestApp();
    for (const userId of [fixture.userB.id, randomUUID(), "not-a-uuid"]) {
      expect((await get(app, `/users/${userId}/rules`, 404)).error).toEqual({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    expect((await get(app, `/users/${fixture.userA.id}/rules`, 404, fixture.accountB.apiKey)).error.code).toBe("USER_NOT_FOUND");
  });

  it("rejects month, account and clock overrides because rule inspection always means current rules", async () => {
    const app = createTestApp();
    for (const query of ["month=2026-09", `accountId=${fixture.accountB.id}`, "clock=2026-11-01"]) {
      for (const path of ["/account/rules", `/users/${fixture.userA.id}/rules`]) {
        expect((await get(app, `${path}?${query}`, 400)).error.code).toBe("INVALID_REQUEST");
      }
    }
  });

  it("clamps current remaining after a downgrade, then reads a new UTC month's zero buckets", async () => {
    const app = createTestApp();
    await write(app, "PATCH", `/users/${fixture.userA.id}/plan`, { planId: fixture.customPlanA.id });
    await spend(app, 4, "october");
    const saved = await savedDecision("october");
    await write(app, "PATCH", `/plans/${fixture.customPlanA.id}`, { monthlyLimit: 2 });
    expect(await get(app, `/users/${fixture.userA.id}/rules`)).toMatchObject({
      month: "2026-10", user: { consumed: 4, remaining: 0, plan: { monthlyLimit: 2, revision: 2 } }
    });
    instant = "2026-11-01T00:00:00Z";
    expect(await get(app, `/users/${fixture.userA.id}/rules`)).toMatchObject({
      month: "2026-11", account: { consumed: 0 }, user: { consumed: 0, remaining: 2, plan: { monthlyLimit: 2, revision: 2 } }
    });
    expect(await savedDecision("october")).toEqual(saved);
    expect(await get(app, `/users/${fixture.userA.id}/usage?month=2026-10`)).toEqual({
      month: "2026-10", isCurrentMonth: false,
      account: { id: fixture.accountA.id, consumed: 4 }, user: { id: fixture.userA.id, consumed: 4 }
    });
  });
});
