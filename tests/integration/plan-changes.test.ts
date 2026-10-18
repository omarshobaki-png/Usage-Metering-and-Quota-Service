import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan, getPlan, listPlans, updateCustomPlan } from "../../src/modules/plans/service.js";
import { consume, type ConsumeOptions } from "../../src/modules/usage/consume.js";
import type { ConsumptionDecision, QuotaScope } from "../../src/modules/usage/contract.js";
import type { ConsumptionSnapshot } from "../../src/modules/usage/snapshot.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for plan-change tests.");

const testId = randomUUID().replaceAll("-", "");
const schemaName = `plan_change_${process.pid}_${testId}`;
const quotedSchemaName = `"${schemaName}"`;
const mutationName = `plan_mutation_${testId}`;
const consumptionName = `plan_consumption_${testId}`;
const poolConfig = {
  connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5_000,
  options: `-c search_path=${schemaName} -c statement_timeout=12000 -c lock_timeout=10000`
};
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const testPool = new Pool(poolConfig);
const mutationPool = new Pool({ ...poolConfig, application_name: mutationName });
const consumptionPool = new Pool({ ...poolConfig, application_name: consumptionName });
const advisoryNamespace = 23;
const advisoryKey = parseInt(testId.slice(0, 7), 16);
const testPepper = "live-plan-test-pepper";
const instant = "2026-10-17T12:30:00.000Z";
const apps: FastifyInstance[] = [];
let fixture: TwoAccountFixture;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(promise: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createTestApp(options: ConsumeOptions = {}): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => { await testPool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(testPool, testPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(testPool, accountId, input),
      getUser: async (accountId, userId) => getUser(testPool, accountId, userId)
    },
    planOperations: {
      createCustomPlan: async (accountId, input) => createCustomPlan(mutationPool, accountId, input),
      listPlans: async (accountId, scope) => listPlans(testPool, accountId, scope),
      getPlan: async (accountId, planId) => getPlan(testPool, accountId, planId),
      updateCustomPlan: async (accountId, planId, input) => updateCustomPlan(mutationPool, accountId, planId, input)
    },
    assignmentOperations: {
      assignAccountPlan: async (accountId, planId) => assignAccountPlan(mutationPool, accountId, planId),
      assignUserPlan: async (accountId, userId, planId) => assignUserPlan(mutationPool, accountId, userId, planId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(consumptionPool, accountId, input, {
        clock: () => new Date(instant), ...options
      })
    },
    logger: false
  });
  apps.push(app);
  return app;
}

function postConsume(app: FastifyInstance, units: number, requestId: string, userId = fixture.userA.id) {
  return app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": fixture.accountA.apiKey },
    payload: { userId, units, requestId }
  });
}

function patch(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url, headers: { "x-api-key": fixture.accountA.apiKey }, payload });
}

function assignmentPath(scope: QuotaScope) {
  return scope === "account" ? "/account/plan" : `/users/${fixture.userA.id}/plan`;
}

async function configurePlan(scope: QuotaScope, limit = 10) {
  const plan = await createCustomPlan(testPool, fixture.accountA.id, {
    name: `Live ${scope}`, scope, monthlyLimit: limit, requestLimit: 100
  });
  if (scope === "account") await assignAccountPlan(testPool, fixture.accountA.id, plan.id);
  else await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, plan.id);
  return plan;
}

async function readAccounting() {
  const accounts = await testPool.query("SELECT to_jsonb(t) AS row FROM account_monthly_usage t ORDER BY account_id, usage_month");
  const users = await testPool.query("SELECT to_jsonb(t) AS row FROM user_monthly_usage t ORDER BY account_id, user_id, usage_month");
  const decisions = await testPool.query("SELECT to_jsonb(t) AS row FROM request_decisions t ORDER BY account_id, request_id");
  return { accounts: accounts.rows, users: users.rows, decisions: decisions.rows };
}

async function savedDecision(requestId: string) {
  const result = await testPool.query<{ row: { decision_snapshot: ConsumptionSnapshot } }>(
    "SELECT to_jsonb(t) AS row FROM request_decisions t WHERE account_id = $1 AND request_id = $2",
    [fixture.accountA.id, requestId]
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.row;
}

async function expectReconciled(total: number, decisionCount: number) {
  const result = await testPool.query(
    `SELECT
       (SELECT COALESCE(SUM(consumed_units),0)::integer FROM account_monthly_usage) AS account,
       (SELECT COALESCE(SUM(consumed_units),0)::integer FROM user_monthly_usage) AS users,
       (SELECT COALESCE(SUM(requested_units) FILTER (WHERE accepted),0)::integer FROM request_decisions) AS ledger,
       (SELECT COUNT(*)::integer FROM request_decisions) AS decisions`
  );
  expect(result.rows).toEqual([{ account: total, users: total, ledger: total, decisions: decisionCount }]);
  const perUser = await testPool.query(`
    SELECT u.user_id FROM user_monthly_usage u
    LEFT JOIN request_decisions d ON d.account_id = u.account_id AND d.user_id = u.user_id
      AND d.processed_month = u.usage_month AND d.accepted
    GROUP BY u.account_id, u.user_id, u.usage_month, u.consumed_units
    HAVING u.consumed_units <> COALESCE(SUM(d.requested_units),0)
  `);
  expect(perUser.rows).toEqual([]);
}

async function waitForLock(applicationName: string, blockerPid?: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await testPool.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event_type = 'Lock'
         AND cardinality(pg_blocking_pids(pid)) > 0
         AND ($2::integer IS NULL OR $2 = ANY(pg_blocking_pids(pid)))) AS waiting`,
      [applicationName, blockerPid ?? null]
    );
    if (result.rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No observed lock wait for ${applicationName}.`);
}

// Pause an actual HTTP mutation after its account lock, without adding a
// production hook or replacing any SQL. Installed only in this temporary schema.
async function installMutationGate(table: "plans" | "accounts" | "users", targetId: number | string) {
  const target = typeof targetId === "number" ? String(targetId) : `'${targetId}'::uuid`;
  await testPool.query(`
    CREATE FUNCTION hold_plan_test_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${advisoryNamespace}, ${advisoryKey});
      RETURN NEW;
    END $$;
    CREATE TRIGGER hold_plan_test_mutation BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN (OLD.id = ${target}) EXECUTE FUNCTION hold_plan_test_mutation();
  `);
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
  await testPool.query(`
    DROP TRIGGER IF EXISTS hold_plan_test_mutation ON plans;
    DROP TRIGGER IF EXISTS hold_plan_test_mutation ON accounts;
    DROP TRIGGER IF EXISTS hold_plan_test_mutation ON users;
    DROP FUNCTION IF EXISTS hold_plan_test_mutation();
  `);
});

afterAll(async () => {
  await Promise.all([testPool.end(), mutationPool.end(), consumptionPool.end()]);
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("live plan changes with PostgreSQL", () => {
  it.each(["account", "user"] as const)("switches, downgrades, and upgrades the %s plan without resetting usage", async (scope) => {
    const oldPlan = await configurePlan(scope);
    const app = createTestApp();
    const original = await postConsume(app, 8, "before-switch");
    expect(original.statusCode).toBe(200);
    expect(original.json().accepted).toBe(true);
    const oldRow = await savedDecision("before-switch");
    const nextPlan = await createCustomPlan(testPool, fixture.accountA.id, {
      name: "Larger Plan", scope, monthlyLimit: 20, requestLimit: 100
    });
    const beforeSwitch = await readAccounting();
    expect((await patch(app, assignmentPath(scope), { planId: nextPlan.id })).statusCode).toBe(200);
    expect(await readAccounting()).toEqual(beforeSwitch);
    // This rejected probe exposes live remaining=12 without adding usage.
    const probe = await postConsume(app, 13, "after-switch-probe");
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ accepted: false, [scope]: {
      consumed: 8, remaining: 12, plan: { id: nextPlan.id, revision: 1 }
    } });
    const beforeDowngrade = await readAccounting();
    const downgrade = await patch(app, `/plans/${nextPlan.id}`, { monthlyLimit: 5 });
    expect(downgrade.statusCode).toBe(200);
    expect(downgrade.json().plan.revision).toBe(2);
    expect(await readAccounting()).toEqual(beforeDowngrade);
    const denied = await postConsume(app, 1, "below-usage");
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({
      accepted: false, blockedBy: { scope, rule: "monthly_limit", limit: 5 },
      [scope]: { consumed: 8, remaining: 0, plan: { id: nextPlan.id, revision: 2 } }
    });
    const deniedRow = await savedDecision("below-usage");
    const upgrade = await patch(app, `/plans/${nextPlan.id}`, { monthlyLimit: 10 });
    expect(upgrade.statusCode).toBe(200);
    expect(upgrade.json().plan.revision).toBe(3);
    const exact = await postConsume(app, 2, "upgrade-exact");
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ accepted: true, [scope]: { consumed: 10, remaining: 0, plan: { revision: 3 } } });
    expect((await postConsume(app, 8, "before-switch")).json()).toEqual(original.json());
    expect((await postConsume(app, 1, "below-usage")).json()).toEqual(denied.json());
    expect(await savedDecision("before-switch")).toEqual(oldRow);
    expect(await savedDecision("below-usage")).toEqual(deniedRow);
    expect(oldRow.decision_snapshot.response[scope].plan.id).toBe(oldPlan.id);
    await expectReconciled(10, 4);
  });

  it("updates a shared user definition while preserving separate usage of 2 and 7", async () => {
    const plan = await configurePlan("user");
    const second = await createUser(testPool, fixture.accountA.id, { planId: plan.id });
    const app = createTestApp();
    const first = await postConsume(app, 2, "first-user");
    const other = await postConsume(app, 7, "second-user", second.id);
    expect(first.json().accepted).toBe(true);
    expect(other.json().accepted).toBe(true);
    const before = await readAccounting();
    const update = await patch(app, `/plans/${plan.id}`, { monthlyLimit: 20 });
    expect(update.statusCode).toBe(200);
    expect(update.json().plan.revision).toBe(2);
    expect(await readAccounting()).toEqual(before);
    for (const [userId, consumed, remaining] of [[fixture.userA.id, 2, 18], [second.id, 7, 13]] as const) {
      const inspection = await app.inject({ method: "GET", url: `/users/${userId}`, headers: { "x-api-key": fixture.accountA.apiKey } });
      expect(inspection.statusCode).toBe(200);
      expect(inspection.json().user.plan).toMatchObject({ id: plan.id, monthlyLimit: 20, revision: 2 });
      const probe = await postConsume(app, 21, `probe-${consumed}`, userId);
      expect(probe.statusCode).toBe(200);
      expect(probe.json()).toMatchObject({ accepted: false, user: { consumed, remaining, plan: { revision: 2 } } });
    }
    expect((await postConsume(app, 2, "first-user")).json()).toEqual(first.json());
    expect((await postConsume(app, 7, "second-user", second.id)).json()).toEqual(other.json());
    await expectReconciled(9, 4);
  });

  it.each(["account", "user"] as const)("uses fresh %s per-request caps and revisions without rewriting rejected history", async (scope) => {
    const plan = await configurePlan(scope, 100);
    const app = createTestApp();
    expect((await patch(app, `/plans/${plan.id}`, { requestLimit: 3 })).statusCode).toBe(200);
    const denied = await postConsume(app, 4, "old-request-cap");
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ accepted: false,
      blockedBy: { scope, rule: "max_units_per_request", limit: 3 }, [scope]: { plan: { revision: 2 } }
    });
    const row = await savedDecision("old-request-cap");
    expect((await patch(app, `/plans/${plan.id}`, { requestLimit: 5 })).statusCode).toBe(200);
    expect((await postConsume(app, 4, "old-request-cap")).json()).toEqual(denied.json());
    const fresh = await postConsume(app, 4, "new-request-cap");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ accepted: true, [scope]: { plan: { revision: 3 } } });
    expect(await savedDecision("old-request-cap")).toEqual(row);
    await expectReconciled(4, 2);
  });

  it("rejects protected/foreign plans and invalid assignments without changing plans, usage, or history", async () => {
    const app = createTestApp();
    expect((await postConsume(app, 4, "protected-accept")).statusCode).toBe(200);
    expect((await postConsume(app, 25, "protected-reject")).statusCode).toBe(200);
    const before = await readAccounting();
    const plans = await testPool.query("SELECT to_jsonb(t) AS row FROM plans t ORDER BY id");
    const subjects = await testPool.query("SELECT id, account_plan_id FROM accounts ORDER BY id");
    const users = await testPool.query("SELECT id, user_plan_id FROM users ORDER BY id");
    const cases: [string, Record<string, unknown>, number, string][] = [
      [`/plans/${fixture.userA.plan.id}`, { monthlyLimit: 5 }, 403, "PREDEFINED_PLAN_READ_ONLY"],
      [`/plans/${fixture.customPlanB.id}`, { monthlyLimit: 5 }, 404, "PLAN_NOT_FOUND"],
      ["/account/plan", { planId: fixture.customPlanA.id }, 422, "PLAN_SCOPE_MISMATCH"],
      [`/users/${fixture.userA.id}/plan`, { planId: fixture.accountA.planId }, 422, "PLAN_SCOPE_MISMATCH"],
      [`/users/${fixture.userA.id}/plan`, { planId: fixture.customPlanB.id }, 404, "PLAN_NOT_FOUND"],
      [`/users/${fixture.userB.id}/plan`, { planId: fixture.customPlanA.id }, 404, "USER_NOT_FOUND"],
      [`/plans/${fixture.customPlanA.id}`, { scope: "account" }, 400, "INVALID_REQUEST"]
    ];
    for (const [url, payload, status, code] of cases) {
      const response = await patch(app, url, payload);
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
    expect(await readAccounting()).toEqual(before);
    expect((await testPool.query("SELECT to_jsonb(t) AS row FROM plans t ORDER BY id")).rows).toEqual(plans.rows);
    expect((await testPool.query("SELECT id, account_plan_id FROM accounts ORDER BY id")).rows).toEqual(subjects.rows);
    expect((await testPool.query("SELECT id, user_plan_id FROM users ORDER BY id")).rows).toEqual(users.rows);
    await expectReconciled(4, 2);
  });

  it.each(["account", "user"] as const)("uses the committed %s downgrade when the update wins the lock", async (scope) => {
    const plan = await configurePlan(scope);
    const app = createTestApp();
    await app.ready();
    await installMutationGate("plans", plan.id);
    const holder = await testPool.connect();
    let work: Promise<PromiseSettledResult<LightMyRequestResponse>[]> = Promise.resolve([]);
    let results: PromiseSettledResult<LightMyRequestResponse>[] = [];
    try {
      await holder.query("SELECT pg_advisory_lock($1,$2)", [advisoryNamespace, advisoryKey]);
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const update = patch(app, `/plans/${plan.id}`, { monthlyLimit: 5 });
      work = Promise.allSettled([update]);
      await waitForLock(mutationName, pid); // Actual mutation owns account lock, paused in trigger.
      const request = postConsume(app, 6, "update-first");
      work = Promise.allSettled([update, request]);
      await waitForLock(consumptionName);
      expect((await getPlan(testPool, fixture.accountA.id, plan.id))?.monthlyLimit).toBe(10);
      expect((await readAccounting()).decisions).toEqual([]);
    } finally {
      try {
        await holder.query("SELECT pg_advisory_unlock($1,$2)", [advisoryNamespace, advisoryKey]);
      } finally {
        holder.release();
        results = await work;
      }
    }
    const [update, request] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(update!.statusCode).toBe(200);
    expect(update!.json().plan.revision).toBe(2);
    expect(request!.statusCode).toBe(200);
    expect(request!.json()).toMatchObject({ accepted: false,
      blockedBy: { scope, rule: "monthly_limit", limit: 5 }, [scope]: { consumed: 0, remaining: 5, plan: { id: plan.id, revision: 2 } }
    });
    const row = await savedDecision("update-first");
    expect(row.decision_snapshot.evaluatedLimits[scope].monthlyLimit).toBe(5);
    await expectReconciled(0, 1);
  }, 20_000);

  it.each(["account", "user"] as const)("preserves acceptance when consumption wins before the %s downgrade", async (scope) => {
    const plan = await configurePlan(scope);
    const entered = gate();
    const release = gate();
    const app = createTestApp({ testHooks: { afterDecisionInsert: async () => {
      entered.release();
      await release.promise;
    } } });
    await app.ready();
    const request = postConsume(app, 6, "consume-first");
    let work: Promise<PromiseSettledResult<LightMyRequestResponse>[]> = Promise.allSettled([request]);
    let results: PromiseSettledResult<LightMyRequestResponse>[] = [];
    try {
      await bounded(entered.promise, "consumption's pre-commit gate");
      const update = patch(app, `/plans/${plan.id}`, { monthlyLimit: 5 });
      work = Promise.allSettled([request, update]);
      await waitForLock(mutationName);
      expect((await getPlan(testPool, fixture.accountA.id, plan.id))?.monthlyLimit).toBe(10);
      expect((await readAccounting()).decisions).toEqual([]); // The acceptance is still uncommitted.
    } finally {
      release.release();
      results = await work;
    }
    const [response, update] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(response!.statusCode).toBe(200);
    expect(response!.json()).toMatchObject({ accepted: true, [scope]: { consumed: 6, remaining: 4, plan: { revision: 1 } } });
    expect(update!.statusCode).toBe(200);
    expect(update!.json().plan.revision).toBe(2);
    const row = await savedDecision("consume-first");
    expect(row.decision_snapshot.evaluatedLimits[scope].monthlyLimit).toBe(10);
    const denied = await postConsume(app, 1, "after-downgrade");
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ accepted: false, [scope]: { consumed: 6, remaining: 0, plan: { revision: 2 } } });
    expect((await postConsume(app, 6, "consume-first")).json()).toEqual(response!.json());
    expect(await savedDecision("consume-first")).toEqual(row);
    await expectReconciled(6, 2);
  }, 20_000);

  it.each(["account", "user"] as const)("reads a newly committed %s assignment after waiting for the account lock", async (scope) => {
    await configurePlan(scope);
    const replacement = await createCustomPlan(testPool, fixture.accountA.id, {
      name: "Replacement", scope, monthlyLimit: 5, requestLimit: 100
    });
    const app = createTestApp();
    await app.ready();
    await installMutationGate(scope === "account" ? "accounts" : "users", scope === "account" ? fixture.accountA.id : fixture.userA.id);
    const holder = await testPool.connect();
    let work: Promise<PromiseSettledResult<LightMyRequestResponse>[]> = Promise.resolve([]);
    let results: PromiseSettledResult<LightMyRequestResponse>[] = [];
    try {
      await holder.query("SELECT pg_advisory_lock($1,$2)", [advisoryNamespace, advisoryKey]);
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const assignment = patch(app, assignmentPath(scope), { planId: replacement.id });
      work = Promise.allSettled([assignment]);
      await waitForLock(mutationName, pid);
      const request = postConsume(app, 6, "assignment-first");
      work = Promise.allSettled([assignment, request]);
      await waitForLock(consumptionName);
    } finally {
      try {
        await holder.query("SELECT pg_advisory_unlock($1,$2)", [advisoryNamespace, advisoryKey]);
      } finally {
        holder.release();
        results = await work;
      }
    }
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      expect(result.value.statusCode).toBe(200);
    }
    const response = (results[1] as PromiseFulfilledResult<LightMyRequestResponse>).value.json<ConsumptionDecision>();
    expect(response).toMatchObject({ accepted: false, blockedBy: { scope, rule: "monthly_limit", limit: 5 },
      [scope]: { consumed: 0, remaining: 5, plan: { id: replacement.id, revision: 1 } }
    });
    await expectReconciled(0, 1);
  }, 20_000);
});
