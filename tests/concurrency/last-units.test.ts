import { randomUUID } from "node:crypto";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan } from "../../src/modules/plans/service.js";
import { consume } from "../../src/modules/usage/consume.js";
import { consumptionDecisionSchema, type ConsumeRequest, type ConsumptionDecision } from "../../src/modules/usage/contract.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for concurrency tests.");
}

// Unlike schema-isolated integration suites, this suite owns a whole temporary DB.
const databaseName = `quota_race_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedDatabaseName = `"${databaseName}"`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.pathname = `/${databaseName}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const testPool = new Pool({
  connectionString: isolatedUrl.toString(),
  max: 24, // Twenty contenders, a lock holder, and an observer must fit at once.
  connectionTimeoutMillis: 5_000,
  application_name: databaseName,
  options: "-c statement_timeout=12000 -c lock_timeout=10000"
});
const testPepper = "concurrency-test-pepper";
const instant = "2026-10-17T12:30:00.000Z";
const apps: FastifyInstance[] = [];
let databaseCreated = false;
let fixture: TwoAccountFixture;

function createTestApp(): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => { await testPool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(testPool, testPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(testPool, accountId, input),
      getUser: async (accountId, userId) => getUser(testPool, accountId, userId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(testPool, accountId, input, {
        clock: () => new Date(instant)
      })
    },
    logger: false
  });
  apps.push(app);
  return app;
}

function postConsume(app: FastifyInstance, payload: ConsumeRequest, apiKey = fixture.accountA.apiKey) {
  return app.inject({ method: "POST", url: "/consume", headers: { "x-api-key": apiKey }, payload });
}

async function configurePlans(accountLimit: number, userLimit: number, userRequestLimit = 100) {
  const accountPlan = await createCustomPlan(testPool, fixture.accountA.id, {
    name: "Race Account", scope: "account", monthlyLimit: accountLimit, requestLimit: 100
  });
  const userPlan = await createCustomPlan(testPool, fixture.accountA.id, {
    name: "Race User", scope: "user", monthlyLimit: userLimit, requestLimit: userRequestLimit
  });
  await assignAccountPlan(testPool, fixture.accountA.id, accountPlan.id);
  await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, userPlan.id);
  return userPlan;
}

async function waitForBlockedRequests(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const result = await testPool.query<{ waiting: number }>(
      `SELECT COUNT(DISTINCT pid)::integer AS waiting FROM pg_stat_activity
       WHERE datname = $1 AND application_name = $1
         AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`,
      [databaseName]
    );
    waiting = result.rows[0]!.waiting;
    if (waiting === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expected} distinct blocked DB connections, observed ${waiting}.`);
}

function unwrap<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function raceRequests(app: FastifyInstance, payloads: ConsumeRequest[]) {
  await app.ready();
  const holder = await testPool.connect();
  let settled: Promise<PromiseSettledResult<LightMyRequestResponse>[]> | undefined;
  let results: PromiseSettledResult<LightMyRequestResponse>[] = [];
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [fixture.accountA.id]);
    let releaseStart!: () => void;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    const requests = payloads.map(async (payload) => {
      await start;
      return postConsume(app, payload);
    });
    // Attach handlers before releasing the barrier, including on failure paths.
    settled = Promise.allSettled(requests);
    releaseStart();
    await waitForBlockedRequests(payloads.length);
    expect(testPool.totalCount).toBeGreaterThanOrEqual(payloads.length + 1);
  } finally {
    try {
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
      // No in-flight request may leak into the next fixture, even on assertion failure.
      if (settled !== undefined) results = await settled;
    }
  }
  return results.map(unwrap);
}

async function withDeadline<T>(promise: PromiseLike<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Independent account did not finish while A was locked.")), milliseconds);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function reconcile(
  responses: LightMyRequestResponse[], total: number, count: number, accountId = fixture.accountA.id
) {
  const account = await testPool.query<{ month: string; consumed: number }>(
    `SELECT to_char(usage_month, 'YYYY-MM') AS month, consumed_units AS consumed
     FROM account_monthly_usage WHERE account_id = $1 ORDER BY usage_month`, [accountId]
  );
  const users = await testPool.query<{ userId: string; consumed: number }>(
    `SELECT user_id AS "userId", consumed_units AS consumed FROM user_monthly_usage
     WHERE account_id = $1 ORDER BY user_id`, [accountId]
  );
  const decisions = await testPool.query<{
    requestId: string; userId: string; units: number; accepted: boolean; response: ConsumptionDecision;
  }>(
    `SELECT request_id AS "requestId", user_id AS "userId", requested_units AS units,
            accepted, decision_snapshot->'response' AS response
     FROM request_decisions WHERE account_id = $1 ORDER BY request_id`, [accountId]
  );
  expect(account.rows).toEqual([{ month: "2026-10", consumed: total }]);
  expect(decisions.rows).toHaveLength(count);
  const ledger = new Map<string, number>();
  for (const decision of decisions.rows) {
    expect(decision.response).toMatchObject({
      requestId: decision.requestId, userId: decision.userId, units: decision.units, accepted: decision.accepted
    });
    if (decision.accepted) ledger.set(decision.userId, (ledger.get(decision.userId) ?? 0) + decision.units);
  }
  expect([...ledger.values()].reduce((sum, units) => sum + units, 0)).toBe(total);
  expect(users.rows.reduce((sum, user) => sum + user.consumed, 0)).toBe(total);
  for (const user of users.rows) expect(user.consumed).toBe(ledger.get(user.userId) ?? 0);
  for (const userId of ledger.keys()) expect(users.rows.some((user) => user.userId === userId)).toBe(true);
  for (const response of responses) {
    if (response.statusCode === 409) {
      expect(response.json().error.code).toBe("REQUEST_ID_CONFLICT");
      continue;
    }
    expect(response.statusCode).toBe(200);
    const body = consumptionDecisionSchema.parse(response.json());
    expect(decisions.rows.find((decision) => decision.requestId === body.requestId)?.response).toEqual(body);
  }
  return decisions.rows;
}

beforeAll(async () => {
  // The configured development/test role needs CREATEDB; never repurpose the source DB.
  await adminPool.query(`CREATE DATABASE ${quotedDatabaseName}`);
  databaseCreated = true;
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
}, 20_000);

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
  try {
    await testPool.end();
    if (databaseCreated) await adminPool.query(`DROP DATABASE ${quotedDatabaseName}`);
  } finally {
    await adminPool.end();
  }
}, 20_000);

describe("real concurrent consumption", () => {
  it.each([1, 2])("accepts exactly ten of twenty 1-unit requests shared by %i user(s)", async (userCount) => {
    const userPlan = await configurePlans(10, 100);
    const userIds = [fixture.userA.id];
    if (userCount === 2) {
      const secondUser = await createUser(testPool, fixture.accountA.id, { planId: userPlan.id });
      userIds.push(secondUser.id);
    }
    const payloads = Array.from({ length: 20 }, (_, index) => ({
      userId: userIds[index % userCount]!, units: 1, requestId: `last-unit-${index}`
    }));
    const responses = await raceRequests(createTestApp(), payloads);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const bodies = responses.map((response) => response.json<ConsumptionDecision>());
    const accepted = bodies.filter((body) => body.accepted);
    const rejected = bodies.filter((body) => !body.accepted);
    expect(accepted).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    expect(accepted.map((body) => body.account.consumed).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    for (const body of rejected) {
      expect(body).toMatchObject({
        blockedBy: { scope: "account", rule: "monthly_limit", limit: 10 },
        account: { consumed: 10, remaining: 0 }
      });
    }
    await reconcile(responses, 10, 20);
  }, 20_000);

  it("accepts five and rejects five when one user's monthly allowance is the bottleneck", async () => {
    await configurePlans(100, 5);
    const responses = await raceRequests(createTestApp(), Array.from({ length: 10 }, (_, index) => ({
      userId: fixture.userA.id, units: 1, requestId: `user-last-unit-${index}`
    })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const bodies = responses.map((response) => response.json<ConsumptionDecision>());
    expect(bodies.filter((body) => body.accepted)).toHaveLength(5);
    const rejected = bodies.filter((body) => !body.accepted);
    expect(rejected).toHaveLength(5);
    for (const body of rejected) expect(body).toMatchObject({
      blockedBy: { scope: "user", rule: "monthly_limit", limit: 5 },
      account: { consumed: 5, remaining: 95 }, user: { consumed: 5, remaining: 0 }
    });
    await reconcile(responses, 5, 10);
  }, 20_000);

  it.each([true, false])("stores one decision for twenty duplicate requests (accepted: %s)", async (accepted) => {
    await configurePlans(100, 100, accepted ? 100 : 2);
    const payload = { userId: fixture.userA.id, units: 3, requestId: "concurrent-duplicate" };
    const responses = await raceRequests(createTestApp(), Array.from({ length: 20 }, () => ({ ...payload })));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(responses[0]!.json());
      expect(response.json().accepted).toBe(accepted);
    }
    await reconcile(responses, accepted ? 3 : 0, 1);
  }, 20_000);

  it.each(["units", "user"] as const)("returns one winning decision and one 409 for conflicting %s", async (field) => {
    const userPlan = await configurePlans(100, 100);
    const first = { userId: fixture.userA.id, units: 3, requestId: "concurrent-conflict" };
    const second = field === "units"
      ? { ...first, units: 4 }
      : { ...first, userId: (await createUser(testPool, fixture.accountA.id, { planId: userPlan.id })).id };
    const responses = await raceRequests(createTestApp(), [first, second]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!.json<ConsumptionDecision>();
    expect(winner.accepted).toBe(true);
    expect([first, second]).toContainEqual({ userId: winner.userId, units: winner.units, requestId: winner.requestId });
    await reconcile(responses, winner.units, 1);
    // Both contenders can still replay the winner, but cannot replace its payload.
    const replay = await postConsume(createTestApp(), {
      userId: winner.userId, units: winner.units, requestId: winner.requestId
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(winner);
    await reconcile([replay], winner.units, 1);
  }, 20_000);

  it("allows account B to finish while account A has a held row lock and waiting consumption", async () => {
    const app = createTestApp();
    await app.ready();
    const holder = await testPool.connect();
    let pendingA: Promise<PromiseSettledResult<LightMyRequestResponse>[]> | undefined;
    let pendingB: Promise<PromiseSettledResult<LightMyRequestResponse>[]> | undefined;
    let resultsA: PromiseSettledResult<LightMyRequestResponse>[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [fixture.accountA.id]);
      pendingA = Promise.allSettled([postConsume(app, {
        userId: fixture.userA.id, units: 3, requestId: "independent-A"
      })]);
      await waitForBlockedRequests(1);
      const requestB = postConsume(app, {
        userId: fixture.userB.id, units: 4, requestId: "independent-B"
      }, fixture.accountB.apiKey);
      pendingB = Promise.allSettled([requestB]);
      const responseB = await withDeadline(requestB, 3_000);
      expect(responseB.statusCode).toBe(200);
      expect(responseB.json().accepted).toBe(true);
      await reconcile([responseB], 4, 1, fixture.accountB.id);
      // A must still be waiting; B's success must not depend on releasing A's lock.
      await waitForBlockedRequests(1);
      const countA = await testPool.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM request_decisions WHERE account_id = $1", [fixture.accountA.id]
      );
      expect(countA.rows[0]!.count).toBe(0);
    } finally {
      try {
        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        if (pendingA !== undefined) resultsA = await pendingA;
        if (pendingB !== undefined) await pendingB;
      }
    }
    const responseA = unwrap(resultsA[0]!);
    expect(responseA.statusCode).toBe(200);
    expect(responseA.json().accepted).toBe(true);
    await reconcile([responseA], 3, 1);
  }, 20_000);
});
