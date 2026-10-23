import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { type Plan } from "../../src/modules/plans/service.js";
import { type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { consumptionDecisionSchema, type ConsumptionDecision } from "../../src/modules/usage/contract.js";
import type { ConsumptionSnapshot } from "../../src/modules/usage/snapshot.js";
import { MAX_QUANTITY } from "../../src/shared/validation.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for consume endpoint tests.");
}

const schemaName = `consume_http_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const testPepper = "consume-http-test-pepper";
const instant = "2026-10-17T12:30:00.000Z";
const apps: FastifyInstance[] = [];

let fixture: TwoAccountFixture;

function createTestApp(options: ConsumeOptions = {}): FastifyInstance {
  const app = buildApp({
    ...createAppOperations(testPool, testPepper, { clock: () => new Date(instant), ...options }),
    logger: false
  });
  apps.push(app);
  return app;
}

async function postConsume(app: FastifyInstance, payload: Record<string, unknown>, apiKey = fixture.accountA.apiKey) {
  return app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": apiKey }, payload
  });
}

async function getSavedDecision(requestId: string, accountId = fixture.accountA.id) {
  const saved = await testPool.query<{
    accountId: string;
    requestId: string;
    userId: string;
    units: number;
    processedAt: Date;
    month: string;
    accepted: boolean;
    reason: string;
    blockingRule: string | null;
    blockingScope: string | null;
    accountPlanId: number;
    userPlanId: number;
    accountRevision: number;
    userRevision: number;
    snapshot: ConsumptionSnapshot;
    snapshotText: string;
  }>(
    `SELECT account_id AS "accountId", request_id AS "requestId", user_id AS "userId",
            requested_units AS units, processed_at AS "processedAt",
            to_char(processed_month, 'YYYY-MM-DD') AS month, accepted,
            decision_reason AS reason, blocking_rule AS "blockingRule", blocking_scope AS "blockingScope",
            account_plan_id AS "accountPlanId", user_plan_id AS "userPlanId",
            account_plan_revision AS "accountRevision", user_plan_revision AS "userRevision",
            decision_snapshot AS snapshot, decision_snapshot::text AS "snapshotText"
     FROM request_decisions WHERE account_id = $1 AND request_id = $2`,
    [accountId, requestId]
  );
  expect(saved.rows).toHaveLength(1);
  return saved.rows[0]!;
}

async function expectNoAccountingRows(): Promise<void> {
  const counts = await testPool.query(`
    SELECT (SELECT count(*) FROM account_monthly_usage) AS accounts,
           (SELECT count(*) FROM user_monthly_usage) AS users,
           (SELECT count(*) FROM request_decisions) AS decisions
  `);
  expect(counts.rows).toEqual([{ accounts: "0", users: "0", decisions: "0" }]);
}

async function configurePlans(
  app: FastifyInstance,
  account: { monthlyLimit: number; requestLimit: number },
  user: { monthlyLimit: number; requestLimit: number }
) {
  const accountResponse = await app.inject({
    method: "POST", url: "/plans", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { name: "HTTP Account Plan", scope: "account", ...account }
  });
  const userResponse = await app.inject({
    method: "POST", url: "/plans", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { name: "HTTP User Plan", scope: "user", ...user }
  });
  expect(accountResponse.statusCode).toBe(201);
  expect(userResponse.statusCode).toBe(201);
  const accountPlan = accountResponse.json<{ plan: Plan }>().plan;
  const userPlan = userResponse.json<{ plan: Plan }>().plan;
  const accountAssignment = await app.inject({
    method: "PATCH", url: "/account/plan", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { planId: accountPlan.id }
  });
  const userAssignment = await app.inject({
    method: "PATCH", url: `/users/${fixture.userA.id}/plan`, headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { planId: userPlan.id }
  });
  expect(accountAssignment.statusCode).toBe(200);
  expect(userAssignment.statusCode).toBe(200);
  return { accountPlan, userPlan };
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

describe("POST /consume with PostgreSQL", () => {
  it("returns the brief's accepted 10-unit example exactly as stored", async () => {
    const payload = { userId: fixture.userA.id, units: 10, requestId: "brief-10" };
    const response = await postConsume(createTestApp(), payload);
    const body = response.json<ConsumptionDecision>();
    expect(response.statusCode).toBe(200);
    expect(consumptionDecisionSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      ...payload, accepted: true, blockedBy: null, processedAt: instant, month: "2026-10",
      account: { consumed: 10, remaining: 9_990, plan: { id: fixture.accountA.planId, revision: 1 } },
      user: { consumed: 10, remaining: 990, plan: { id: fixture.userA.plan.id, revision: 1 } }
    });
    const saved = await getSavedDecision(payload.requestId);
    expect(saved).toMatchObject({
      accountId: fixture.accountA.id, requestId: payload.requestId, userId: fixture.userA.id,
      units: 10, processedAt: new Date(instant), month: "2026-10-01",
      accepted: true, reason: "accepted", blockingRule: null, blockingScope: null,
      accountPlanId: fixture.accountA.planId, userPlanId: fixture.userA.plan.id,
      accountRevision: 1, userRevision: 1,
      snapshot: {
        response: body,
        evaluatedLimits: {
          account: { monthlyLimit: 10_000, maxUnitsPerRequest: 100 },
          user: { monthlyLimit: 1_000, maxUnitsPerRequest: 20 }
        }
      }
    });
    expect(response.body).not.toContain(fixture.accountA.apiKey);
    expect(response.body).not.toContain("evaluatedLimits");
  });

  it("records the brief's 25-unit rejection with the original user cap of 20", async () => {
    const response = await postConsume(createTestApp(), {
      userId: fixture.userA.id, units: 25, requestId: "brief-25"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: false, blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 },
      account: { consumed: 0, remaining: 10_000 }, user: { consumed: 0, remaining: 1_000 }
    });
    const saved = await getSavedDecision("brief-25");
    expect(saved.snapshot.response).toEqual(response.json());
    expect(saved.snapshot.evaluatedLimits.user.maxUnitsPerRequest).toBe(20);
    const usage = await testPool.query("SELECT consumed_units FROM account_monthly_usage UNION ALL SELECT consumed_units FROM user_monthly_usage");
    expect(usage.rows).toEqual([{ consumed_units: 0 }, { consumed_units: 0 }]);
  });

  it.each([
    {
      name: "account per-request", units: 11, initial: 0,
      account: { monthlyLimit: 1_000, requestLimit: 10 }, user: { monthlyLimit: 1_000, requestLimit: 100 },
      blockedBy: { scope: "account", rule: "max_units_per_request", limit: 10 }
    },
    {
      name: "user per-request", units: 25, initial: 0,
      account: { monthlyLimit: 1_000, requestLimit: 100 }, user: { monthlyLimit: 1_000, requestLimit: 20 },
      blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 }
    },
    {
      name: "account monthly", units: 6, initial: 95,
      account: { monthlyLimit: 100, requestLimit: 100 }, user: { monthlyLimit: 1_000, requestLimit: 100 },
      blockedBy: { scope: "account", rule: "monthly_limit", limit: 100 }
    },
    {
      name: "user monthly", units: 6, initial: 95,
      account: { monthlyLimit: 1_000, requestLimit: 100 }, user: { monthlyLimit: 100, requestLimit: 100 },
      blockedBy: { scope: "user", rule: "monthly_limit", limit: 100 }
    }
  ])("enforces the isolated $name blocker through HTTP", async ({ units, initial, account, user, blockedBy }) => {
    const app = createTestApp();
    const { accountPlan, userPlan } = await configurePlans(app, account, user);
    if (initial > 0) {
      const seed = await postConsume(app, { userId: fixture.userA.id, units: initial, requestId: "initial" });
      expect(seed.json().accepted).toBe(true);
    }
    const response = await postConsume(app, { userId: fixture.userA.id, units, requestId: "isolated-blocker" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: false, blockedBy,
      account: { consumed: initial, remaining: account.monthlyLimit - initial },
      user: { consumed: initial, remaining: user.monthlyLimit - initial }
    });
    const saved = await getSavedDecision("isolated-blocker");
    expect(saved).toMatchObject({
      accepted: false, reason: "quota_exceeded", blockingScope: blockedBy.scope, blockingRule: blockedBy.rule,
      accountPlanId: accountPlan.id, userPlanId: userPlan.id, accountRevision: 1, userRevision: 1,
      snapshot: {
        response: response.json(),
        evaluatedLimits: {
          account: { monthlyLimit: account.monthlyLimit, maxUnitsPerRequest: account.requestLimit },
          user: { monthlyLimit: user.monthlyLimit, maxUnitsPerRequest: user.requestLimit }
        }
      }
    });
    const totals = await testPool.query("SELECT consumed_units FROM account_monthly_usage UNION ALL SELECT consumed_units FROM user_monthly_usage");
    expect(totals.rows).toEqual([{ consumed_units: initial }, { consumed_units: initial }]);
  });

  it("accepts the exact monthly boundary and rejects the next unit", async () => {
    const app = createTestApp();
    await configurePlans(app, { monthlyLimit: 5, requestLimit: 100 }, { monthlyLimit: 5, requestLimit: 100 });
    const accepted = await postConsume(app, { userId: fixture.userA.id, units: 5, requestId: "exact" });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, account: { consumed: 5, remaining: 0 }, user: { consumed: 5, remaining: 0 } });
    const rejected = await postConsume(app, { userId: fixture.userA.id, units: 1, requestId: "over" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ accepted: false, account: { consumed: 5, remaining: 0 }, user: { consumed: 5, remaining: 0 } });
    expect((await getSavedDecision("exact")).snapshot.response).toEqual(accepted.json());
  });

  it("reconciles two users, the shared account total, and accepted decisions", async () => {
    const app = createTestApp();
    const created = await app.inject({ method: "POST", url: "/users", headers: { "x-api-key": fixture.accountA.apiKey }, payload: {} });
    expect(created.statusCode).toBe(201);
    const secondUserId = created.json().user.id as string;
    const first = await postConsume(app, { userId: fixture.userA.id, units: 10, requestId: "user-10" });
    const second = await postConsume(app, { userId: secondUserId, units: 7, requestId: "user-7" });
    const denied = await postConsume(app, { userId: secondUserId, units: 25, requestId: "denied-25" });
    expect(first.json().accepted).toBe(true);
    expect(second.json()).toMatchObject({ accepted: true, account: { consumed: 17 }, user: { consumed: 7 } });
    expect(denied.json().accepted).toBe(false);

    const totals = await testPool.query(`
      SELECT bucket.consumed_units AS account,
        (SELECT sum(consumed_units)::text FROM user_monthly_usage WHERE account_id = bucket.account_id AND usage_month = bucket.usage_month) AS users,
        (SELECT sum(requested_units)::text FROM request_decisions WHERE account_id = bucket.account_id AND processed_month = bucket.usage_month AND accepted) AS ledger,
        (SELECT count(*) FROM request_decisions WHERE account_id = bucket.account_id AND accepted) AS accepted,
        (SELECT count(*) FROM request_decisions WHERE account_id = bucket.account_id AND NOT accepted) AS rejected
      FROM account_monthly_usage AS bucket WHERE bucket.account_id = $1
    `, [fixture.accountA.id]);
    expect(totals.rows).toEqual([{ account: 17, users: "17", ledger: "17", accepted: "2", rejected: "1" }]);
    const users = await testPool.query("SELECT user_id AS id, consumed_units AS consumed FROM user_monthly_usage WHERE account_id = $1", [fixture.accountA.id]);
    expect(users.rows).toEqual(expect.arrayContaining([{ id: fixture.userA.id, consumed: 10 }, { id: secondUserId, consumed: 7 }]));
    expect(users.rows).toHaveLength(2);
    expect((await getSavedDecision("user-10")).snapshot.response).toEqual(first.json());
  });

  it("keeps an accepted snapshot unchanged after both plans are edited through HTTP", async () => {
    const app = createTestApp();
    const { accountPlan, userPlan } = await configurePlans(app,
      { monthlyLimit: 100, requestLimit: 100 }, { monthlyLimit: 20, requestLimit: 10 });
    const response = await postConsume(app, { userId: fixture.userA.id, units: 4, requestId: "before-edit" });
    expect(response.json().accepted).toBe(true);
    const savedBefore = await getSavedDecision("before-edit");
    for (const [planId, monthlyLimit, requestLimit] of [[accountPlan.id, 200, 200], [userPlan.id, 3, 2]]) {
      const update = await app.inject({
        method: "PATCH", url: `/plans/${planId}`, headers: { "x-api-key": fixture.accountA.apiKey },
        payload: { monthlyLimit, requestLimit }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().plan.revision).toBe(2);
    }
    const later = await postConsume(app, { userId: fixture.userA.id, units: 1, requestId: "after-edit" });
    expect(later.json()).toMatchObject({
      accepted: false, blockedBy: { scope: "user", rule: "monthly_limit", limit: 3 },
      account: { consumed: 4, remaining: 196, plan: { revision: 2 } },
      user: { consumed: 4, remaining: 0, plan: { revision: 2 } }
    });
    expect(await getSavedDecision("before-edit")).toEqual(savedBefore);
    expect(savedBefore.snapshot.response).toEqual(response.json());
    expect(savedBefore.snapshot.evaluatedLimits).toEqual({
      account: { monthlyLimit: 100, maxUnitsPerRequest: 100 },
      user: { monthlyLimit: 20, maxUnitsPerRequest: 10 }
    });
  });

  it("keeps a rejected snapshot's blocking cap after a plan increase", async () => {
    const app = createTestApp();
    const { userPlan } = await configurePlans(app,
      { monthlyLimit: 10_000, requestLimit: 100 }, { monthlyLimit: 1_000, requestLimit: 20 });
    const input = { userId: fixture.userA.id, units: 25, requestId: "old-denial" };
    const rejected = await postConsume(app, input);
    expect(rejected.json()).toMatchObject({ accepted: false, blockedBy: { limit: 20 } });
    const before = await getSavedDecision(input.requestId);
    const update = await app.inject({
      method: "PATCH", url: `/plans/${userPlan.id}`, headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { requestLimit: 30 }
    });
    expect(update.statusCode).toBe(200);
    const fresh = await postConsume(app, { ...input, requestId: "new-attempt" });
    expect(fresh.json().accepted).toBe(true);
    expect((await postConsume(app, input)).json()).toEqual(rejected.json());
    expect(await getSavedDecision(input.requestId)).toEqual(before);
    expect(before.snapshot.evaluatedLimits.user.maxUnitsPerRequest).toBe(20);
    expect((await getSavedDecision("new-attempt")).snapshot.evaluatedLimits.user.maxUnitsPerRequest).toBe(30);
  });

  it("rejects a malformed stored snapshot without charging the retry", async () => {
    const app = createTestApp();
    const input = { userId: fixture.userA.id, units: 4, requestId: "malformed-snapshot" };
    expect((await postConsume(app, input)).json().accepted).toBe(true);

    await testPool.query(
      "UPDATE request_decisions SET decision_snapshot = '{}'::jsonb WHERE account_id = $1 AND request_id = $2",
      [fixture.accountA.id, input.requestId]
    );
    const saved = await getSavedDecision(input.requestId);
    const response = await postConsume(app, input);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(response.json()).not.toHaveProperty("accepted");
    expect(await getSavedDecision(input.requestId)).toEqual(saved);
    const usage = await testPool.query(`
      SELECT
        (SELECT consumed_units FROM account_monthly_usage WHERE account_id = $1) AS account,
        (SELECT consumed_units FROM user_monthly_usage WHERE user_id = $2) AS "user",
        (SELECT count(*) FROM request_decisions WHERE account_id = $1) AS decisions
    `, [fixture.accountA.id, fixture.userA.id]);
    expect(usage.rows).toEqual([{ account: 4, user: 4, decisions: "1" }]);
  });

  it.each(["missing", "malformed", "unknown"])("rejects a %s API key without creating accounting rows", async (kind) => {
    const app = createTestApp();
    const response = await app.inject({
      method: "POST", url: "/consume", payload: { userId: fixture.userA.id, units: 4, requestId: "unauthorized" },
      ...(kind === "missing" ? {} : { headers: { "x-api-key": kind === "malformed" ? "invalid" : `umq_${"z".repeat(43)}` } })
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await expectNoAccountingRows();
  });

  it.each([0, -1, 1.5, "4", null, MAX_QUANTITY + 1])("rejects units=%s without recording a decision", async (units) => {
    const response = await postConsume(createTestApp(), { userId: fixture.userA.id, units, requestId: "invalid-units" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    await expectNoAccountingRows();
  });

  it.each(["accountId", "processedAt", "clock", "testHooks"])("rejects a client-supplied %s override", async (field) => {
    const response = await postConsume(createTestApp(), {
      userId: fixture.userA.id, units: 4, requestId: "override", [field]: "client-supplied"
    });
    expect(response.statusCode).toBe(400);
    await expectNoAccountingRows();
  });

  it("returns a safe malformed-JSON error without recording anything", async () => {
    const response = await createTestApp().inject({
      method: "POST", url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey, "content-type": "application/json" },
      payload: '{"userId":'
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
    await expectNoAccountingRows();
  });

  it.each(["foreign", "unknown"])("hides a %s user and leaves both accounts unchanged", async (kind) => {
    const response = await postConsume(createTestApp(), {
      userId: kind === "foreign" ? fixture.userB.id : randomUUID(), units: 4, requestId: "unavailable"
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "USER_NOT_FOUND" } });
    await expectNoAccountingRows();
  });

  it.each(["afterAccountIncrement", "afterDecisionInsert"] as const)("returns only a safe error after a fault at %s", async (stage) => {
    const faultingApp = createTestApp({ testHooks: { [stage]: () => { throw new Error("private SQL postgres://private:secret@db"); } } });
    const input = { userId: fixture.userA.id, units: 4, requestId: "recover-after-fault" };
    const failed = await postConsume(faultingApp, input);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
    expect(failed.json()).not.toHaveProperty("accepted");
    expect(failed.body).not.toContain("private");
    expect(failed.body).not.toContain("secret");
    await expectNoAccountingRows();
    const recovered = await postConsume(createTestApp(), input);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ accepted: true, account: { consumed: 4 }, user: { consumed: 4 } });
    expect((await getSavedDecision(input.requestId)).snapshot.response).toEqual(recovered.json());
  });

  it("offers no HTTP mutation path for an existing decision", async () => {
    const app = createTestApp();
    const input = { userId: fixture.userA.id, units: 4, requestId: "append-only" };
    expect((await postConsume(app, input)).statusCode).toBe(200);
    const before = await getSavedDecision(input.requestId);
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey }, payload: input });
      expect(response.statusCode).toBe(404);
    }
    expect(await getSavedDecision(input.requestId)).toEqual(before);
  });
});
