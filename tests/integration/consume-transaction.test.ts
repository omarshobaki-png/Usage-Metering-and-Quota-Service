import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan, updateCustomPlan } from "../../src/modules/plans/service.js";
import { consume } from "../../src/modules/usage/consume.js";
import { consumptionDecisionSchema, type ConsumptionDecision } from "../../src/modules/usage/contract.js";
import { createUser } from "../../src/modules/users/service.js";
import { InvalidRequestError, RequestIdConflictError } from "../../src/shared/errors.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for consumption tests.");
}

const schemaName = `consume_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({ connectionString: databaseUrl, options: poolOptions });
const instant = "2026-10-17T12:30:00.000Z";
const fixedClock = () => new Date(instant);

let fixture: TwoAccountFixture;

async function readState(accountId = fixture.accountA.id) {
  const account = await testPool.query(
    `SELECT to_char(usage_month, 'YYYY-MM-DD') AS month, consumed_units AS consumed
     FROM account_monthly_usage WHERE account_id = $1 ORDER BY usage_month`,
    [accountId]
  );
  const users = await testPool.query(
    `SELECT user_id AS "userId", to_char(usage_month, 'YYYY-MM-DD') AS month,
            consumed_units AS consumed
     FROM user_monthly_usage WHERE account_id = $1 ORDER BY user_id, usage_month`,
    [accountId]
  );
  const decisions = await testPool.query(
    `SELECT request_id AS "requestId", user_id AS "userId", requested_units AS units,
            processed_at AS "processedAt", to_char(processed_month, 'YYYY-MM-DD') AS month,
            accepted, blocking_rule AS rule, blocking_scope AS scope,
            decision_snapshot AS snapshot
     FROM request_decisions WHERE account_id = $1 ORDER BY request_id`,
    [accountId]
  );
  return { account: account.rows, users: users.rows, decisions: decisions.rows };
}

async function configurePlans(
  account: { monthlyLimit: number; requestLimit: number },
  user: { monthlyLimit: number; requestLimit: number }
) {
  const accountPlan = await createCustomPlan(testPool, fixture.accountA.id, {
    name: "Transaction Account Plan", scope: "account", ...account
  });
  const userPlan = await createCustomPlan(testPool, fixture.accountA.id, {
    name: "Transaction User Plan", scope: "user", ...user
  });
  await assignAccountPlan(testPool, fixture.accountA.id, accountPlan.id);
  await assignUserPlan(testPool, fixture.accountA.id, fixture.userA.id, userPlan.id);
  return { accountPlan, userPlan };
}

async function waitForAccountLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const waiting = await adminPool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'
           AND cardinality(pg_blocking_pids(pid)) > 0
       ) AS waiting`,
      [applicationName]
    );
    if (waiting.rows[0]?.waiting) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The consumption request did not wait for the account lock.");
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
  fixture = await createTwoAccountFixture(testPool, "consume-transaction-test-pepper");
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("atomic consumption", () => {
  it("commits four units at both scopes and exactly one matching decision snapshot", async () => {
    const input = { userId: fixture.userA.id, units: 4, requestId: "accepted-4" };
    const result = await consume(testPool, fixture.accountA.id, input, { clock: fixedClock });
    expect(consumptionDecisionSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      ...input, accepted: true, blockedBy: null, processedAt: instant, month: "2026-10",
      account: { consumed: 4, remaining: 9_996, plan: { id: fixture.accountA.planId, revision: 1 } },
      user: { consumed: 4, remaining: 996, plan: { id: fixture.userA.plan.id, revision: 1 } }
    });

    const state = await readState();
    expect(state.account).toEqual([{ month: "2026-10-01", consumed: 4 }]);
    expect(state.users).toEqual([{ userId: fixture.userA.id, month: "2026-10-01", consumed: 4 }]);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      requestId: input.requestId, units: 4, processedAt: new Date(instant),
      month: "2026-10-01", accepted: true, rule: null, scope: null,
      snapshot: {
        response: result,
        evaluatedLimits: {
          account: { monthlyLimit: 10_000, maxUnitsPerRequest: 100 },
          user: { monthlyLimit: 1_000, maxUnitsPerRequest: 20 }
        }
      }
    });
  });

  it.each([
    {
      name: "account request limit", units: 11, initial: 0,
      account: { monthlyLimit: 1_000, requestLimit: 10 },
      user: { monthlyLimit: 1_000, requestLimit: 100 },
      blockedBy: { scope: "account", rule: "max_units_per_request", limit: 10 }
    },
    {
      name: "user request limit", units: 25, initial: 0,
      account: { monthlyLimit: 1_000, requestLimit: 100 },
      user: { monthlyLimit: 1_000, requestLimit: 20 },
      blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 }
    },
    {
      name: "account monthly allowance", units: 6, initial: 95,
      account: { monthlyLimit: 100, requestLimit: 100 },
      user: { monthlyLimit: 1_000, requestLimit: 100 },
      blockedBy: { scope: "account", rule: "monthly_limit", limit: 100 }
    },
    {
      name: "user monthly allowance", units: 6, initial: 95,
      account: { monthlyLimit: 1_000, requestLimit: 100 },
      user: { monthlyLimit: 100, requestLimit: 100 },
      blockedBy: { scope: "user", rule: "monthly_limit", limit: 100 }
    }
  ])("records a rejection for $name without consuming units", async ({ units, initial, account, user, blockedBy }) => {
    await configurePlans(account, user);
    if (initial > 0) {
      await consume(testPool, fixture.accountA.id, {
        userId: fixture.userA.id, units: initial, requestId: "initial"
      }, { clock: fixedClock });
    }
    const result = await consume(testPool, fixture.accountA.id, {
      userId: fixture.userA.id, units, requestId: "denied"
    }, { clock: fixedClock });

    expect(result).toMatchObject({
      accepted: false, blockedBy,
      account: { consumed: initial, remaining: account.monthlyLimit - initial },
      user: { consumed: initial, remaining: user.monthlyLimit - initial }
    });
    const state = await readState();
    expect(state.account).toEqual([{ month: "2026-10-01", consumed: initial }]);
    expect(state.users).toEqual([{ userId: fixture.userA.id, month: "2026-10-01", consumed: initial }]);
    expect(state.decisions).toHaveLength(initial > 0 ? 2 : 1);
    expect(state.decisions.find((row) => row.requestId === "denied")).toMatchObject({
      accepted: false, rule: blockedBy.rule, scope: blockedBy.scope,
      snapshot: { response: result }
    });
  });

  it.each([
    { stage: "afterAccountIncrement", initial: 0 },
    { stage: "afterDecisionInsert", initial: 0 },
    { stage: "afterAccountIncrement", initial: 7 },
    { stage: "afterDecisionInsert", initial: 7 }
  ] as const)("rolls back $stage with initial usage $initial and releases the connection", async ({ stage, initial }) => {
    if (initial > 0) {
      await consume(testPool, fixture.accountA.id, {
        userId: fixture.userA.id, units: initial, requestId: "initial"
      }, { clock: fixedClock });
    }
    const before = await readState();
    const singlePool = new Pool({
      connectionString: databaseUrl, options: poolOptions, max: 1,
      connectionTimeoutMillis: 1_000
    });
    const connectSpy = vi.spyOn(singlePool, "connect");
    const input = { userId: fixture.userA.id, units: 4, requestId: "retry-after-fault" };
    let insideAccountTotal: number | undefined;
    let insideDecisionCount: string | undefined;

    try {
      await expect(consume(singlePool, fixture.accountA.id, input, {
        clock: fixedClock,
        testHooks: {
          [stage]: async (client: PoolClient) => {
            const own = await client.query<{ consumed: number }>(
              "SELECT consumed_units AS consumed FROM account_monthly_usage WHERE account_id = $1",
              [fixture.accountA.id]
            );
            insideAccountTotal = own.rows[0]?.consumed;
            const decisions = await client.query<{ count: string }>(
              "SELECT count(*) FROM request_decisions WHERE account_id = $1",
              [fixture.accountA.id]
            );
            insideDecisionCount = decisions.rows[0]?.count;
            expect(await readState()).toEqual(before);
            throw new Error(`Injected ${stage} failure`);
          }
        }
      })).rejects.toThrow(`Injected ${stage} failure`);

      expect(insideAccountTotal).toBe(initial + 4);
      expect(insideDecisionCount).toBe(String((initial > 0 ? 1 : 0) + (stage === "afterDecisionInsert" ? 1 : 0)));
      expect(await readState()).toEqual(before);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(singlePool.totalCount).toBe(1);
      expect(singlePool.idleCount).toBe(1);
      expect(singlePool.waitingCount).toBe(0);

      const retried = await consume(singlePool, fixture.accountA.id, input, { clock: fixedClock });
      expect(retried).toMatchObject({ accepted: true, account: { consumed: initial + 4 }, user: { consumed: initial + 4 } });
      const after = await readState();
      expect(after.decisions.filter((row) => row.requestId === input.requestId)).toHaveLength(1);
      expect(after.account[0]?.consumed).toBe(initial + 4);
      expect(after.users[0]?.consumed).toBe(initial + 4);
      expect(connectSpy).toHaveBeenCalledTimes(2);
      expect(singlePool.idleCount).toBe(1);
    } finally {
      connectSpy.mockRestore();
      await singlePool.end();
    }
  });

  it("uses one connection and READ COMMITTED even if the session default is repeatable read", async () => {
    const singlePool = new Pool({
      connectionString: databaseUrl,
      options: `${poolOptions} -c default_transaction_isolation=repeatable\\ read`,
      max: 1, connectionTimeoutMillis: 1_000
    });
    let isolation: string | undefined;
    const backends: number[] = [];
    const inspect = async (client: PoolClient) => {
      const result = await client.query<{ isolation: string; backend: number }>(
        "SELECT current_setting('transaction_isolation') AS isolation, pg_backend_pid() AS backend"
      );
      isolation = result.rows[0]?.isolation;
      backends.push(result.rows[0]!.backend);
    };

    try {
      const result = await consume(singlePool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 4, requestId: "single-connection"
      }, { clock: fixedClock, testHooks: { afterAccountIncrement: inspect, afterDecisionInsert: inspect } });
      expect(result?.accepted).toBe(true);
      expect(isolation).toBe("read committed");
      expect(backends).toHaveLength(2);
      expect(backends[0]).toBe(backends[1]);
      expect(singlePool.totalCount).toBe(1);
      expect(singlePool.idleCount).toBe(1);
    } finally {
      await singlePool.end();
    }
  });

  it("reads updated plans and captures the test clock only after a real account-lock wait", async () => {
    const { accountPlan } = await configurePlans(
      { monthlyLimit: 30, requestLimit: 100 },
      { monthlyLimit: 100, requestLimit: 100 }
    );
    const blocker = await testPool.connect();
    const applicationName = `consume_wait_${randomUUID()}`;
    const waitingPool = new Pool({
      connectionString: databaseUrl, options: poolOptions, application_name: applicationName,
      max: 1, connectionTimeoutMillis: 1_000
    });
    let currentTime = "2026-10-31T23:59:59.999Z";
    let clockCalls = 0;
    let pending: Promise<ConsumptionDecision | null> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [fixture.accountA.id]);
      await blocker.query("UPDATE plans SET monthly_limit = 5, revision = revision + 1 WHERE id = $1", [accountPlan.id]);
      pending = consume(waitingPool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 6, requestId: "waited-across-midnight"
      }, { clock: () => { clockCalls += 1; return new Date(currentTime); } });
      void pending.catch(() => undefined);
      await waitForAccountLock(applicationName);
      expect(clockCalls).toBe(0);
      currentTime = "2026-11-01T00:00:00.000Z";
      await blocker.query("COMMIT");

      const result = await pending;
      expect(clockCalls).toBe(1);
      expect(result).toMatchObject({
        accepted: false, month: "2026-11", processedAt: currentTime,
        blockedBy: { scope: "account", rule: "monthly_limit", limit: 5 },
        account: { consumed: 0, remaining: 5, plan: { id: accountPlan.id, revision: 2 } }
      });
      expect((await readState()).account).toEqual([{ month: "2026-11-01", consumed: 0 }]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
      await waitingPool.end();
    }
  });

  it("uses a PostgreSQL processing timestamp later than transaction start after waiting", async () => {
    const blocker = await testPool.connect();
    const applicationName = `consume_time_${randomUUID()}`;
    const waitingPool = new Pool({ connectionString: databaseUrl, options: poolOptions, application_name: applicationName, max: 1 });
    let transactionStartedAt: Date | undefined;
    let pending: Promise<ConsumptionDecision | null> | undefined;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [fixture.accountA.id]);
      pending = consume(waitingPool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 4, requestId: "database-clock"
      }, { testHooks: { afterDecisionInsert: async (client) => {
        const time = await client.query<{ started: Date }>("SELECT transaction_timestamp() AS started");
        transactionStartedAt = time.rows[0]?.started;
      } } });
      void pending.catch(() => undefined);
      await waitForAccountLock(applicationName);
      const releaseTime = await blocker.query<{ released: Date }>("SELECT clock_timestamp() AS released");
      await blocker.query("COMMIT");

      const result = await pending;
      expect(transactionStartedAt!.getTime()).toBeLessThanOrEqual(releaseTime.rows[0]!.released.getTime());
      expect(new Date(result!.processedAt).getTime()).toBeGreaterThanOrEqual(releaseTime.rows[0]!.released.getTime());
      expect(result?.accepted).toBe(true);
      expect((await readState()).decisions[0]?.processedAt.toISOString()).toBe(result?.processedAt);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending?.catch(() => undefined);
      await waitingPool.end();
    }
  });

  it("leaves no data for an unknown or foreign user", async () => {
    const beforeA = await readState();
    const beforeB = await readState(fixture.accountB.id);
    for (const userId of [fixture.userB.id, randomUUID()]) {
      expect(await consume(testPool, fixture.accountA.id, {
        userId, units: 4, requestId: "unavailable-user"
      }, { clock: fixedClock })).toBeNull();
    }
    expect(await readState()).toEqual(beforeA);
    expect(await readState(fixture.accountB.id)).toEqual(beforeB);
  });

  it("validates direct service input before opening a transaction", async () => {
    const connectSpy = vi.spyOn(testPool, "connect");
    try {
      await expect(consume(testPool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 0, requestId: "invalid"
      })).rejects.toBeInstanceOf(InvalidRequestError);
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("replays the stored response without new charges or a new processing time", async () => {
    const input = { userId: fixture.userA.id, units: 4, requestId: "replay" };
    const first = await consume(testPool, fixture.accountA.id, input, { clock: fixedClock });
    const before = await readState();
    const clock = vi.fn(() => { throw new Error("A replay must not read a new clock"); });
    expect(await consume(testPool, fixture.accountA.id, input, { clock })).toEqual(first);
    expect(clock).not.toHaveBeenCalled();
    expect(await readState()).toEqual(before);
  });

  it("normalizes UUID case so identical users cannot be mistaken for a payload conflict", async () => {
    const input = { userId: fixture.userA.id.toUpperCase(), units: 4, requestId: "uuid-case" };
    const first = await consume(testPool, fixture.accountA.id, input, { clock: fixedClock });
    expect(first?.userId).toBe(fixture.userA.id);
    expect(await consume(testPool, fixture.accountA.id, input, { clock: fixedClock })).toEqual(first);
    expect((await readState()).decisions).toHaveLength(1);
  });

  it("rejects changed units or owned user for an existing request ID without new writes", async () => {
    const secondUser = await createUser(testPool, fixture.accountA.id);
    const input = { userId: fixture.userA.id, units: 4, requestId: "conflict" };
    await consume(testPool, fixture.accountA.id, input, { clock: fixedClock });
    const before = await readState();
    for (const changed of [{ ...input, units: 5 }, { ...input, userId: secondUser.id }]) {
      await expect(consume(testPool, fixture.accountA.id, changed, { clock: fixedClock }))
        .rejects.toBeInstanceOf(RequestIdConflictError);
    }
    expect(await readState()).toEqual(before);
  });

  it("allows two accounts to use the same request ID independently", async () => {
    for (const [account, user] of [[fixture.accountA, fixture.userA], [fixture.accountB, fixture.userB]] as const) {
      const result = await consume(testPool, account.id, {
        userId: user.id, units: 4, requestId: "shared-id"
      }, { clock: fixedClock });
      expect(result?.accepted).toBe(true);
      expect((await readState(account.id)).account[0]?.consumed).toBe(4);
      expect((await readState(account.id)).decisions).toHaveLength(1);
    }
  });

  it("preserves saved rules and balances after a custom-plan update", async () => {
    const { userPlan } = await configurePlans(
      { monthlyLimit: 100, requestLimit: 100 }, { monthlyLimit: 20, requestLimit: 10 }
    );
    const input = { userId: fixture.userA.id, units: 4, requestId: "historical" };
    const first = await consume(testPool, fixture.accountA.id, input, { clock: fixedClock });
    const before = await readState();
    await updateCustomPlan(testPool, fixture.accountA.id, userPlan.id, { monthlyLimit: 50 });
    expect(await readState()).toEqual(before);
    expect(await consume(testPool, fixture.accountA.id, input, { clock: fixedClock })).toEqual(first);
  });

  it("rolls back a real COMMIT-time database error and permits subsequent work", async () => {
    await testPool.query(`
      CREATE FUNCTION reject_fixture_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Forced commit failure' USING ERRCODE = 'P0001';
      END;
      $$;
      CREATE CONSTRAINT TRIGGER reject_fixture_commit
      AFTER INSERT ON request_decisions DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.request_id = 'commit-failure')
      EXECUTE FUNCTION reject_fixture_commit();
    `);
    const singlePool = new Pool({ connectionString: databaseUrl, options: poolOptions, max: 1, connectionTimeoutMillis: 1_000 });
    try {
      await expect(consume(singlePool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 4, requestId: "commit-failure"
      }, { clock: fixedClock })).rejects.toMatchObject({ code: "P0001" });
      expect(await readState()).toEqual({ account: [], users: [], decisions: [] });
      expect(singlePool.idleCount).toBe(1);
      const next = await consume(singlePool, fixture.accountA.id, {
        userId: fixture.userA.id, units: 4, requestId: "after-commit-failure"
      }, { clock: fixedClock });
      expect(next?.accepted).toBe(true);
      expect((await readState()).account[0]?.consumed).toBe(4);
    } finally {
      await singlePool.end();
      await testPool.query("DROP TRIGGER reject_fixture_commit ON request_decisions; DROP FUNCTION reject_fixture_commit()");
    }
  });
});
