import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan } from "../../src/modules/plans/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("A PostgreSQL test URL is required for the tenant matrix.");
const schema = `tenant_matrix_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: databaseUrl, max: 4,
  options: `-c search_path=${schema} -c statement_timeout=5000`
});
const pepper = "tenant-matrix-integration-pepper";
const clock = () => new Date("2026-10-18T08:00:00.000Z");
let app: FastifyInstance | undefined;
let origin: string;
let fixture: TwoAccountFixture;
let accountPlanA: number;
let accountPlanB: number;

interface RequestSpec { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown }
function request(method: RequestSpec["method"], path: string, body?: unknown): RequestSpec {
  return { method, path, ...(body === undefined ? {} : { body }) };
}

async function send(spec: RequestSpec, key?: string) {
  const response = await fetch(`${origin}${spec.path}`, {
    method: spec.method,
    headers: {
      ...(key === undefined ? {} : { "x-api-key": key }),
      ...(spec.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    signal: AbortSignal.timeout(5_000)
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

async function state(): Promise<string> {
  const rows: Record<string, unknown> = {};
  for (const table of ["accounts", "plans", "users", "account_monthly_usage", "user_monthly_usage", "request_decisions"]) {
    rows[table] = (await pool.query(
      `SELECT to_jsonb(t) - 'api_key_digest' AS row FROM ${table} t ORDER BY to_jsonb(t)::text`
    )).rows;
  }
  return JSON.stringify(rows);
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
  app = buildApp({
    ...createAppOperations(pool, pepper, { clock }),
    logger: false
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});

beforeEach(async () => {
  // New accounts for every matrix row: no reliance on test order or old state.
  fixture = await createTwoAccountFixture(pool, pepper);
  const plans: number[] = [];
  for (const [account, user, userPlan] of [
    [fixture.accountA, fixture.userA, fixture.customPlanA],
    [fixture.accountB, fixture.userB, fixture.customPlanB]
  ] as const) {
    const plan = await createCustomPlan(pool, account.id, {
      name: `${account.name} Private Account Plan`, scope: "account",
      monthlyLimit: 200, requestLimit: 100
    });
    plans.push(plan.id);
    await assignAccountPlan(pool, account.id, plan.id);
    await assignUserPlan(pool, account.id, user.id, userPlan.id);
    for (const [requestId, units, accepted] of [["shared-accepted", 2, true], ["shared-rejected", 6, false]] as const) {
      const result = await send(request("POST", "/consume", { userId: user.id, units, requestId }), account.apiKey);
      expect(result.status).toBe(200);
      expect(result.json.accepted).toBe(accepted);
    }
  }
  [accountPlanA, accountPlanB] = plans as [number, number];
});

afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

const ownerRoutes = [
  ["GET /account", () => request("GET", "/account"), 200],
  ["POST /users", () => request("POST", "/users", { planId: fixture.customPlanA.id }), 201],
  ["GET /users/:id", () => request("GET", `/users/${fixture.userA.id}`), 200],
  ["GET /plans", () => request("GET", "/plans"), 200],
  ["POST /plans", () => request("POST", "/plans", { name: "New Owner Plan", scope: "user", monthlyLimit: 50, requestLimit: 5 }), 201],
  ["GET /plans/:id", () => request("GET", `/plans/${fixture.customPlanA.id}`), 200],
  ["PATCH /plans/:id", () => request("PATCH", `/plans/${fixture.customPlanA.id}`, { monthlyLimit: 60 }), 200],
  ["PATCH /account/plan", () => request("PATCH", "/account/plan", { planId: accountPlanA }), 200],
  ["PATCH /users/:id/plan", () => request("PATCH", `/users/${fixture.userA.id}/plan`, { planId: fixture.customPlanA.id }), 200],
  ["POST /consume", () => request("POST", "/consume", { userId: fixture.userA.id, units: 1, requestId: "owner-new-action" }), 200],
  ["GET /usage", () => request("GET", "/usage"), 200],
  ["GET /usage historical", () => request("GET", "/usage?month=2026-09"), 200],
  ["GET /users/:id/usage", () => request("GET", `/users/${fixture.userA.id}/usage`), 200],
  ["GET /users/:id/usage historical", () => request("GET", `/users/${fixture.userA.id}/usage?month=2026-09`), 200],
  ["GET /account/rules", () => request("GET", "/account/rules"), 200],
  ["GET /users/:id/rules", () => request("GET", `/users/${fixture.userA.id}/rules`), 200],
  ["GET /history", () => request("GET", "/history"), 200],
  ["GET /history historical", () => request("GET", "/history?month=2026-09"), 200]
] as const;

interface Target { user: string; plan: number; accountPlan: number }
const foreignRoutes: [string, (target: Target) => RequestSpec][] = [
  ["read user", (t) => request("GET", `/users/${t.user}`)],
  ["read user plan", (t) => request("GET", `/plans/${t.plan}`)],
  ["read account plan", (t) => request("GET", `/plans/${t.accountPlan}`)],
  ["edit user plan", (t) => request("PATCH", `/plans/${t.plan}`, { monthlyLimit: 90 })],
  ["edit account plan", (t) => request("PATCH", `/plans/${t.accountPlan}`, { monthlyLimit: 300 })],
  ["create user on foreign user plan", (t) => request("POST", "/users", { planId: t.plan })],
  ["create user on foreign wrong-scope plan", (t) => request("POST", "/users", { planId: t.accountPlan })],
  ["assign foreign account plan", (t) => request("PATCH", "/account/plan", { planId: t.accountPlan })],
  ["assign foreign wrong-scope plan to account", (t) => request("PATCH", "/account/plan", { planId: t.plan })],
  ["assign foreign plan to own user", (t) => request("PATCH", `/users/${fixture.userA.id}/plan`, { planId: t.plan })],
  ["assign own plan to foreign user", (t) => request("PATCH", `/users/${t.user}/plan`, { planId: fixture.customPlanA.id })],
  ["assign foreign plan to foreign user", (t) => request("PATCH", `/users/${t.user}/plan`, { planId: t.plan })],
  ["consume for foreign user with an already-used accepted ID", (t) => request("POST", "/consume", { userId: t.user, units: 2, requestId: "shared-accepted" })],
  ["consume for foreign user with an already-used rejected ID", (t) => request("POST", "/consume", { userId: t.user, units: 6, requestId: "shared-rejected" })],
  ["consume for foreign user with a new ID", (t) => request("POST", "/consume", { userId: t.user, units: 1, requestId: "foreign-new-action" })],
  ["read current user usage", (t) => request("GET", `/users/${t.user}/usage`)],
  ["read historical user usage", (t) => request("GET", `/users/${t.user}/usage?month=2026-09`)],
  ["read user rules", (t) => request("GET", `/users/${t.user}/rules`)],
  ["read user history", (t) => request("GET", `/history?userId=${t.user}`)],
  ["read historical user history", (t) => request("GET", `/history?userId=${t.user}&month=2026-09`)]
];

describe("tenant security matrix through real HTTP", () => {
  it.each(ownerRoutes)("authenticates %s before allowing its owner", async (_label, make, success) => {
    const before = await state();
    let generic: unknown;
    for (const key of [undefined, "", "invalid-key", `umq_${"z".repeat(43)}`]) {
      const denied = await send(make(), key);
      expect(denied.status).toBe(401);
      expect(denied.json.error.code).toBe("UNAUTHORIZED");
      generic ??= denied.json.error;
      expect(denied.json.error).toEqual(generic);
      expect(await state()).toBe(before);
    }
    const own = await send(make(), fixture.accountA.apiKey);
    expect(own.status).toBe(success);
    for (const privateValue of [fixture.accountB.id, fixture.userB.id, fixture.customPlanB.name, fixture.accountA.apiKey, fixture.accountB.apiKey]) {
      expect(own.text).not.toContain(privateValue);
    }
  });

  it.each(foreignRoutes)("hides foreign resources and preserves both accounts: %s", async (_label, make) => {
    const before = await state();
    const foreign = await send(make({
      user: fixture.userB.id, plan: fixture.customPlanB.id, accountPlan: accountPlanB
    }), fixture.accountA.apiKey);
    const missing = await send(make({
      user: randomUUID(), plan: 2_000_000_000, accountPlan: 2_000_000_001
    }), fixture.accountA.apiKey);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.json.error).toEqual(missing.json.error);
    for (const privateValue of [fixture.accountB.id, fixture.userB.id, fixture.customPlanB.name, fixture.accountB.apiKey]) {
      expect(foreign.text).not.toContain(privateValue);
    }
    expect(await state()).toBe(before);
  });

  it("rejects a foreign history cursor without changing either account", async () => {
    const before = await state();
    const foreign = await send(request("GET", "/history?limit=1"), fixture.accountB.apiKey);
    expect(foreign.status).toBe(200);
    expect(foreign.json.nextCursor).toEqual(expect.any(String));
    const denied = await send(request("GET", `/history?cursor=${foreign.json.nextCursor}`), fixture.accountA.apiKey);
    expect(denied.status).toBe(400);
    expect(denied.json.error.code).toBe("INVALID_REQUEST");
    expect(denied.text).not.toContain(fixture.userB.id);
    expect(await state()).toBe(before);
  });

  it("gets account identity only from the key and rejects ownership overrides without writes", async () => {
    const before = await state();
    const own = await send(request("GET", `/account?accountId=${fixture.accountB.id}`), fixture.accountA.apiKey);
    expect(own.status).toBe(200);
    expect(own.json.account.id).toBe(fixture.accountA.id);
    for (const spec of [
      request("POST", "/users", { accountId: fixture.accountB.id }),
      request("POST", "/plans", { name: "Injected", scope: "user", monthlyLimit: 10, requestLimit: 1, accountId: fixture.accountB.id }),
      request("POST", "/consume", { userId: fixture.userA.id, units: 1, requestId: "injected", accountId: fixture.accountB.id }),
      request("PATCH", "/account/plan", { planId: accountPlanA, accountId: fixture.accountB.id }),
      request("PATCH", `/users/${fixture.userA.id}/plan`, { planId: fixture.customPlanA.id, accountId: fixture.accountB.id }),
      request("GET", `/usage?accountId=${fixture.accountB.id}`),
      request("GET", `/account/rules?accountId=${fixture.accountB.id}`),
      request("GET", `/history?accountId=${fixture.accountB.id}`)
    ]) {
      const denied = await send(spec, fixture.accountA.apiKey);
      expect(denied.status).toBe(400);
      expect(denied.json.error.code).toBe("INVALID_REQUEST");
      expect(await state()).toBe(before);
    }
  });
});
