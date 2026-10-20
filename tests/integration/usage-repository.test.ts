import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withLockedAccountTransaction } from "../../src/db/account-transaction.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { getUtcMonth, type UtcMonth } from "../../src/modules/usage/month.js";
import {
  ensureAccountUsageBucket,
  ensureUserUsageBucket,
  getAccountUsage,
  getUserUsage,
  incrementAccountUsage,
  incrementUserUsage,
  UsageBucketNotFoundError
} from "../../src/modules/usage/usage-repository.js";
import { createUser, type User } from "../../src/modules/users/service.js";
import { MAX_QUANTITY } from "../../src/shared/validation.js";
import {
  createTwoAccountFixture,
  type TwoAccountFixture
} from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for usage tests.");
}

const schemaName = `usage_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName}`
});
const october = getUtcMonth(new Date("2026-10-31T23:59:59.999Z"));
const november = getUtcMonth(new Date("2026-11-01T00:00:00.000Z"));

let fixture: TwoAccountFixture;
let secondUserA: User;

async function withClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

// Controlled database fixtures, not a consumption service or quota decision path.
async function recordFixtureUsage(
  accountId: string,
  userId: string,
  month: UtcMonth,
  units: number
): Promise<void> {
  await withLockedAccountTransaction(testPool, accountId, async (client) => {
    await ensureAccountUsageBucket(client, accountId, month);
    await ensureUserUsageBucket(client, accountId, userId, month);
    await incrementAccountUsage(client, accountId, month, units);
    await incrementUserUsage(client, accountId, userId, month, units);
  });
}

async function insertDecisionFixture(
  client: PoolClient,
  accountId: string,
  userId: string,
  requestId: string,
  units: number,
  month: UtcMonth,
  accepted: boolean
): Promise<void> {
  const result = await client.query(
    `
      INSERT INTO request_decisions (
        account_id, request_id, user_id, requested_units, processed_month,
        accepted, decision_reason, blocking_rule, blocking_scope,
        account_plan_id, user_plan_id, account_plan_revision,
        user_plan_revision, decision_snapshot
      )
      SELECT
        accounts.id, $2, users.id, $4, $5, $6,
        CASE WHEN $6 THEN 'accepted' ELSE 'quota_exceeded' END,
        CASE WHEN $6 THEN NULL ELSE 'max_units_per_request' END,
        CASE WHEN $6 THEN NULL ELSE 'account' END,
        accounts.account_plan_id, users.user_plan_id, 1, 1, '{"fixture":true}'
      FROM accounts
      JOIN users ON users.account_id = accounts.id
      WHERE accounts.id = $1 AND users.id = $3
    `,
    [accountId, requestId, userId, units, month, accepted]
  );
  expect(result.rowCount).toBe(1);
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
    DELETE FROM plans WHERE owner_account_id IS NOT NULL;
    DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(testPool, "usage-bucket-test-pepper");
  secondUserA = await createUser(testPool, fixture.accountA.id);
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("monthly usage buckets", () => {
  it("reads missing buckets as zero without creating rows", async () => {
    await withClient(async (client) => {
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(0);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(0);
      const counts = await client.query(`
        SELECT
          (SELECT count(*) FROM account_monthly_usage) AS accounts,
          (SELECT count(*) FROM user_monthly_usage) AS users
      `);
      expect(counts.rows).toEqual([{ accounts: "0", users: "0" }]);
    });
  });

  it("handles competing first-use initialization with one row per bucket", async () => {
    const first = await testPool.connect();
    const second = await testPool.connect();

    try {
      await Promise.all([
        ensureAccountUsageBucket(first, fixture.accountA.id, october),
        ensureAccountUsageBucket(second, fixture.accountA.id, october)
      ]);
      const userTotals = await Promise.all([
        ensureUserUsageBucket(first, fixture.accountA.id, fixture.userA.id, october),
        ensureUserUsageBucket(second, fixture.accountA.id, fixture.userA.id, october)
      ]);
      expect(userTotals).toEqual([0, 0]);
      const counts = await first.query(`
        SELECT
          (SELECT count(*) FROM account_monthly_usage) AS accounts,
          (SELECT count(*) FROM user_monthly_usage) AS users
      `);
      expect(counts.rows).toEqual([{ accounts: "1", users: "1" }]);
      expect(await getAccountUsage(first, fixture.accountA.id, october)).toBe(0);
      expect(await getUserUsage(first, fixture.accountA.id, fixture.userA.id, october)).toBe(0);
    } finally {
      first.release();
      second.release();
    }
  });

  it("does not reset existing totals when initializing again", async () => {
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, october, 3);
    await withClient(async (client) => {
      await ensureAccountUsageBucket(client, fixture.accountA.id, october);
      expect(await ensureUserUsageBucket(client, fixture.accountA.id, fixture.userA.id, october)).toBe(3);
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(3);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(3);
    });
  });

  it("keeps shared-plan users and different accounts independent", async () => {
    expect(secondUserA.plan.id).toBe(fixture.userA.plan.id);
    expect(fixture.userB.plan.id).toBe(fixture.userA.plan.id);
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, october, 3);
    await recordFixtureUsage(fixture.accountA.id, secondUserA.id, october, 7);
    await recordFixtureUsage(fixture.accountB.id, fixture.userB.id, october, 4);

    await withClient(async (client) => {
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(10);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(3);
      expect(await getUserUsage(client, fixture.accountA.id, secondUserA.id, october)).toBe(7);
      expect(await getAccountUsage(client, fixture.accountB.id, october)).toBe(4);
      expect(await getUserUsage(client, fixture.accountB.id, fixture.userB.id, october)).toBe(4);
    });
  });

  it("starts a new month at zero and preserves the previous month after new writes", async () => {
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, october, 3);
    await recordFixtureUsage(fixture.accountA.id, secondUserA.id, october, 7);
    await withClient(async (client) => {
      expect(await getAccountUsage(client, fixture.accountA.id, november)).toBe(0);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, november)).toBe(0);
      expect(await getUserUsage(client, fixture.accountA.id, secondUserA.id, november)).toBe(0);
    });

    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, november, 2);
    await withClient(async (client) => {
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(10);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(3);
      expect(await getUserUsage(client, fixture.accountA.id, secondUserA.id, october)).toBe(7);
      expect(await getAccountUsage(client, fixture.accountA.id, november)).toBe(2);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, november)).toBe(2);
      expect(await getUserUsage(client, fixture.accountA.id, secondUserA.id, november)).toBe(0);
    });
  });

  it("requires initialized buckets before increments", async () => {
    await withClient(async (client) => {
      await expect(incrementAccountUsage(client, fixture.accountA.id, october, 1))
        .rejects.toBeInstanceOf(UsageBucketNotFoundError);
      await expect(incrementUserUsage(client, fixture.accountA.id, fixture.userA.id, october, 1))
        .rejects.toBeInstanceOf(UsageBucketNotFoundError);
    });
  });

  it("prevents foreign-user reads, initialization, and updates from accessing a bucket", async () => {
    await recordFixtureUsage(fixture.accountB.id, fixture.userB.id, october, 4);
    await withClient(async (client) => {
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userB.id, october)).toBe(0);
      await expect(ensureUserUsageBucket(client, fixture.accountA.id, fixture.userB.id, october))
        .rejects.toBeInstanceOf(UsageBucketNotFoundError);
      await expect(ensureUserUsageBucket(client, fixture.accountA.id, fixture.userB.id, november))
        .rejects.toMatchObject({ code: "23503" });
      await expect(incrementUserUsage(client, fixture.accountA.id, fixture.userB.id, october, 1))
        .rejects.toBeInstanceOf(UsageBucketNotFoundError);
      expect(await getUserUsage(client, fixture.accountB.id, fixture.userB.id, october)).toBe(4);
      expect(await getUserUsage(client, fixture.accountB.id, fixture.userB.id, november)).toBe(0);
    });
  });

  it.each(["account", "user"] as const)("rejects direct duplicate %s buckets", async (scope) => {
    await withClient(async (client) => {
      await ensureAccountUsageBucket(client, fixture.accountA.id, october);
      await ensureUserUsageBucket(client, fixture.accountA.id, fixture.userA.id, october);
      const attempt = scope === "account"
        ? client.query(
            "INSERT INTO account_monthly_usage (account_id, usage_month) VALUES ($1, $2)",
            [fixture.accountA.id, october]
          )
        : client.query(
            "INSERT INTO user_monthly_usage (account_id, user_id, usage_month) VALUES ($1, $2, $3)",
            [fixture.accountA.id, fixture.userA.id, october]
          );
      await expect(attempt).rejects.toMatchObject({ code: "23505" });
    });
  });

  it.each([
    { name: "negative account usage", scope: "account", units: -1, orphan: false, code: "23514" },
    { name: "negative user usage", scope: "user", units: -1, orphan: false, code: "23514" },
    { name: "orphan account", scope: "account", units: 0, orphan: true, code: "23503" },
    { name: "orphan user", scope: "user", units: 0, orphan: true, code: "23503" }
  ])("rejects $name at the database boundary", async ({ scope, units, orphan, code }) => {
    await withClient(async (client) => {
      const attempt = scope === "account"
        ? client.query(
            "INSERT INTO account_monthly_usage (account_id, usage_month, consumed_units) VALUES ($1, $2, $3)",
            [orphan ? randomUUID() : fixture.accountA.id, october, units]
          )
        : client.query(
            "INSERT INTO user_monthly_usage (account_id, user_id, usage_month, consumed_units) VALUES ($1, $2, $3, $4)",
            [fixture.accountA.id, orphan ? randomUUID() : fixture.userA.id, october, units]
          );
      await expect(attempt).rejects.toMatchObject({ code });
    });
  });

  it.each([0, -1, 1.5, MAX_QUANTITY + 1])("rejects increment units=%s without changing usage", async (units) => {
    await withClient(async (client) => {
      await ensureAccountUsageBucket(client, fixture.accountA.id, october);
      await ensureUserUsageBucket(client, fixture.accountA.id, fixture.userA.id, october);
      await expect(incrementAccountUsage(client, fixture.accountA.id, october, units)).rejects.toThrow();
      await expect(incrementUserUsage(client, fixture.accountA.id, fixture.userA.id, october, units)).rejects.toThrow();
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(0);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(0);
    });
  });

  it("rejects arithmetic overflow without wrapping or changing the stored totals", async () => {
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, october, MAX_QUANTITY);
    await withClient(async (client) => {
      await expect(incrementAccountUsage(client, fixture.accountA.id, october, 1))
        .rejects.toMatchObject({ code: "22003" });
      await expect(incrementUserUsage(client, fixture.accountA.id, fixture.userA.id, october, 1))
        .rejects.toMatchObject({ code: "22003" });
      expect(await getAccountUsage(client, fixture.accountA.id, october)).toBe(MAX_QUANTITY);
      expect(await getUserUsage(client, fixture.accountA.id, fixture.userA.id, october)).toBe(MAX_QUANTITY);
    });
  });

  it("reconciles account buckets with user totals and accepted decision units by month", async () => {
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, october, 3);
    await recordFixtureUsage(fixture.accountA.id, secondUserA.id, october, 7);
    await recordFixtureUsage(fixture.accountA.id, fixture.userA.id, november, 2);
    await recordFixtureUsage(fixture.accountB.id, fixture.userB.id, october, 4);

    await withClient(async (client) => {
      await insertDecisionFixture(client, fixture.accountA.id, fixture.userA.id, "oct-3", 3, october, true);
      await insertDecisionFixture(client, fixture.accountA.id, secondUserA.id, "oct-7", 7, october, true);
      await insertDecisionFixture(client, fixture.accountA.id, fixture.userA.id, "nov-2", 2, november, true);
      await insertDecisionFixture(client, fixture.accountB.id, fixture.userB.id, "oct-4", 4, october, true);
      await insertDecisionFixture(client, fixture.accountA.id, fixture.userA.id, "denied", 999, october, false);

      const invariantSql = `
        SELECT
          bucket.account_id AS "accountId",
          to_char(bucket.usage_month, 'YYYY-MM-DD') AS month,
          bucket.consumed_units AS consumed,
          bucket.consumed_units = COALESCE((
            SELECT sum(usage.consumed_units)
            FROM user_monthly_usage AS usage
            WHERE usage.account_id = bucket.account_id
              AND usage.usage_month = bucket.usage_month
          ), 0) AS "usersMatch",
          bucket.consumed_units = COALESCE((
            SELECT sum(decision.requested_units)
            FROM request_decisions AS decision
            WHERE decision.account_id = bucket.account_id
              AND decision.processed_month = bucket.usage_month
              AND decision.accepted
          ), 0) AS "decisionsMatch"
        FROM account_monthly_usage AS bucket
        ORDER BY bucket.consumed_units
      `;
      const invariant = await client.query(invariantSql);

      expect(invariant.rows).toEqual([
        { accountId: fixture.accountA.id, month: november, consumed: 2, usersMatch: true, decisionsMatch: true },
        { accountId: fixture.accountB.id, month: october, consumed: 4, usersMatch: true, decisionsMatch: true },
        { accountId: fixture.accountA.id, month: october, consumed: 10, usersMatch: true, decisionsMatch: true }
      ]);

      // Deliberately unbalanced test data must be detected by the same query.
      await incrementUserUsage(client, fixture.accountA.id, fixture.userA.id, october, 1);
      await insertDecisionFixture(client, fixture.accountA.id, fixture.userA.id, "unbalanced", 1, october, true);
      const unbalanced = await client.query(invariantSql);
      expect(unbalanced.rows).toContainEqual({
        accountId: fixture.accountA.id,
        month: october,
        consumed: 10,
        usersMatch: false,
        decisionsMatch: false
      });
    });
  });

  it("participates in the caller's rollback without committing its own writes", async () => {
    await expect(withLockedAccountTransaction(testPool, fixture.accountA.id, async (client) => {
      await ensureAccountUsageBucket(client, fixture.accountA.id, october);
      await ensureUserUsageBucket(client, fixture.accountA.id, fixture.userA.id, october);
      await incrementAccountUsage(client, fixture.accountA.id, october, 3);
      throw new Error("Abort fixture transaction");
    })).rejects.toThrow("Abort fixture transaction");

    await withClient(async (client) => {
      const counts = await client.query(`
        SELECT
          (SELECT count(*) FROM account_monthly_usage) AS accounts,
          (SELECT count(*) FROM user_monthly_usage) AS users
      `);
      expect(counts.rows).toEqual([{ accounts: "0", users: "0" }]);
    });
  });
});
