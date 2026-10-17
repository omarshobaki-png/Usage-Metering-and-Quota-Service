import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { MAX_QUANTITY } from "../../src/shared/validation.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for schema tests.");
}

const schemaName = `schema_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName}`
});

const accountPlanId = 1;
const userPlanId = 2;
const accountAId = "00000000-0000-4000-8000-000000000010";
const accountBId = "00000000-0000-4000-8000-000000000011";
const userAId = "00000000-0000-4000-8000-000000000020";
const userBId = "00000000-0000-4000-8000-000000000021";

let firstMigrationRun: string[];

async function insertDecision(
  accountId: string,
  requestId: string,
  userId: string,
  requestedUnits = 1
): Promise<void> {
  await testPool.query(
    `
      INSERT INTO request_decisions (
        account_id,
        request_id,
        user_id,
        requested_units,
        processed_month,
        accepted,
        decision_reason,
        account_plan_id,
        user_plan_id,
        account_plan_revision,
        user_plan_revision,
        decision_snapshot
      )
      VALUES ($1, $2, $3, $6, '2026-10-01', true, 'accepted', $4, $5, 1, 1, '{}')
    `,
    [accountId, requestId, userId, accountPlanId, userPlanId, requestedUnits]
  );
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  firstMigrationRun = await runMigrations(testPool);
});

beforeEach(async () => {
  await testPool.query(`
    TRUNCATE TABLE
      request_decisions,
      user_monthly_usage,
      account_monthly_usage,
      users,
      plans,
      accounts
    CASCADE
  `);

  await testPool.query(
    `
      INSERT INTO plans (
        id, scope, name, monthly_limit, max_units_per_request
      )
      VALUES
        ($1, 'account', 'Starter', 1000, 100),
        ($2, 'user', 'Basic', 100, 20)
    `,
    [accountPlanId, userPlanId]
  );

  await testPool.query(
    `
      INSERT INTO accounts (id, name, api_key_digest, account_plan_id)
      VALUES
        ($1, 'Account A', 'digest-a', $3),
        ($2, 'Account B', 'digest-b', $3)
    `,
    [accountAId, accountBId, accountPlanId]
  );

  await testPool.query(
    `
      INSERT INTO users (id, account_id, user_plan_id)
      VALUES
        ($1, $3, $5),
        ($2, $4, $5)
    `,
    [userAId, userBId, accountAId, accountBId, userPlanId]
  );
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("database schema", () => {
  it("applies the initial migration once and preserves rows on a repeated run", async () => {
    expect(firstMigrationRun).toEqual([
      "initial_schema.sql",
      "modification_1_plan_ids_as_integers.sql"
    ]);
    await expect(runMigrations(testPool)).resolves.toEqual([]);

    const accountCount = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM accounts"
    );
    expect(accountCount.rows[0]?.count).toBe("2");
  });

  it("rejects negative usage and invalid plan scopes", async () => {
    await expect(
      testPool.query(
        `
          INSERT INTO account_monthly_usage (
            account_id, usage_month, consumed_units
          )
          VALUES ($1, '2026-10-01', -1)
        `,
        [accountAId]
      )
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      testPool.query(
        `
          INSERT INTO plans (scope, name, monthly_limit, max_units_per_request)
          VALUES ('team', 'Invalid', 10, 1)
        `
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it.each([0, MAX_QUANTITY])(
    "round-trips limits and both usage totals of %s as exact JavaScript numbers",
    async (quantity) => {
      await testPool.query(
        `
          UPDATE plans
          SET monthly_limit = $1, max_units_per_request = $1
          WHERE id = $2
        `,
        [quantity, accountPlanId]
      );
      await testPool.query(
        `
          INSERT INTO account_monthly_usage (
            account_id, usage_month, consumed_units
          )
          VALUES ($1, '2026-10-01', $2)
        `,
        [accountAId, quantity]
      );
      await testPool.query(
        `
          INSERT INTO user_monthly_usage (
            account_id, user_id, usage_month, consumed_units
          )
          VALUES ($1, $2, '2026-10-01', $3)
        `,
        [accountAId, userAId, quantity]
      );

      const stored = await testPool.query<{ quantity: number }>(
        `
          SELECT monthly_limit AS quantity FROM plans WHERE id = $1
          UNION ALL
          SELECT max_units_per_request FROM plans WHERE id = $1
          UNION ALL
          SELECT consumed_units FROM account_monthly_usage WHERE account_id = $2
          UNION ALL
          SELECT consumed_units FROM user_monthly_usage WHERE user_id = $3
        `,
        [accountPlanId, accountAId, userAId]
      );

      expect(stored.rows).toEqual([
        { quantity },
        { quantity },
        { quantity },
        { quantity }
      ]);
    }
  );

  it.each([1, MAX_QUANTITY])(
    "round-trips decision units of %s as an exact JavaScript number",
    async (requestedUnits) => {
      await insertDecision(accountAId, "numeric-boundary", userAId, requestedUnits);

      const stored = await testPool.query<{ requestedUnits: number }>(
        `
          SELECT requested_units AS "requestedUnits"
          FROM request_decisions
          WHERE account_id = $1 AND request_id = 'numeric-boundary'
        `,
        [accountAId]
      );

      expect(stored.rows).toEqual([{ requestedUnits }]);
    }
  );

  it.each([
    {
      field: "plan monthly limit",
      sql: "UPDATE plans SET monthly_limit = $1 WHERE id = $2",
      parameters: [MAX_QUANTITY + 1, accountPlanId]
    },
    {
      field: "plan per-request limit",
      sql: "UPDATE plans SET max_units_per_request = $1 WHERE id = $2",
      parameters: [MAX_QUANTITY + 1, accountPlanId]
    },
    {
      field: "account monthly usage",
      sql: `
        INSERT INTO account_monthly_usage (
          account_id, usage_month, consumed_units
        )
        VALUES ($1, '2026-10-01', $2)
      `,
      parameters: [accountAId, MAX_QUANTITY + 1]
    },
    {
      field: "user monthly usage",
      sql: `
        INSERT INTO user_monthly_usage (
          account_id, user_id, usage_month, consumed_units
        )
        VALUES ($1, $2, '2026-10-01', $3)
      `,
      parameters: [accountAId, userAId, MAX_QUANTITY + 1]
    },
    {
      field: "decision requested units",
      sql: `
        INSERT INTO request_decisions (
          account_id, request_id, user_id, requested_units, processed_month,
          accepted, decision_reason, account_plan_id, user_plan_id,
          account_plan_revision, user_plan_revision, decision_snapshot
        )
        VALUES ($1, 'overflow', $2, $3, '2026-10-01', true, 'accepted', $4, $5, 1, 1, '{}')
      `,
      parameters: [accountAId, userAId, MAX_QUANTITY + 1, accountPlanId, userPlanId]
    }
  ])("rejects overflow in $field instead of rounding", async ({ sql, parameters }) => {
    await expect(testPool.query(sql, parameters)).rejects.toMatchObject({
      code: "22003"
    });
  });

  it("rejects foreign-key references to missing users", async () => {
    await expect(
      testPool.query(
        `
          INSERT INTO user_monthly_usage (
            account_id, user_id, usage_month, consumed_units
          )
          VALUES ($1, $2, '2026-10-01', 1)
        `,
        [accountAId, randomUUID()]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("scopes request identifiers to an account", async () => {
    await insertDecision(accountAId, "request-1", userAId);

    await expect(
      insertDecision(accountAId, "request-1", userAId)
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      insertDecision(accountBId, "request-1", userBId)
    ).resolves.toBeUndefined();
  });

  it("rejects a decision for a user owned by another account", async () => {
    await expect(
      insertDecision(accountAId, "tenant-mismatch", userBId)
    ).rejects.toMatchObject({ code: "23503" });
  });
});
