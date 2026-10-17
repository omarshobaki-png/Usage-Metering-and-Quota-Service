import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccountNotFoundError } from "../../src/db/account-transaction.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  predefinedPlans,
  seedPredefinedPlans
} from "../../src/db/seed.js";
import { provisionAccount } from "../../src/modules/accounts/provision-account.js";
import { PlanAssignmentError } from "../../src/modules/plans/assignment.js";
import { createUser, getUser } from "../../src/modules/users/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for user tests.");
}

const schemaName = `user_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "user-test-pepper-value";

let accountAId: string;
let accountBId: string;

function predefinedPlanId(name: string): number {
  const plan = predefinedPlans.find((candidate) => candidate.name === name);

  if (plan === undefined) {
    throw new Error(`Missing predefined plan: ${name}`);
  }

  return plan.id;
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  await testPool.query("DELETE FROM users");
  await testPool.query("DELETE FROM plans WHERE owner_account_id IS NOT NULL");
  await testPool.query("DELETE FROM accounts");

  const accountA = await provisionAccount(testPool, {
    name: "Account A",
    apiKeyPepper: testPepper
  });
  const accountB = await provisionAccount(testPool, {
    name: "Account B",
    planName: "Pro",
    apiKeyPepper: testPepper
  });
  accountAId = accountA.id;
  accountBId = accountB.id;
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("account-owned users", () => {
  it("creates independent users that share the default Basic plan", async () => {
    const first = await createUser(testPool, accountAId);
    const second = await createUser(testPool, accountAId);

    expect(first.id).not.toBe(second.id);
    expect(first.accountId).toBe(accountAId);
    expect(second.accountId).toBe(accountAId);
    expect(first.plan.id).toBe(predefinedPlanId("Basic"));
    expect(second.plan.id).toBe(first.plan.id);

    const usageResult = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM user_monthly_usage"
    );
    expect(usageResult.rows[0]?.count).toBe("0");
  });

  it("scopes user lookup to its owning account", async () => {
    const accountBUser = await createUser(testPool, accountBId, {
      planId: predefinedPlanId("Premium")
    });

    await expect(
      getUser(testPool, accountBId, accountBUser.id)
    ).resolves.toMatchObject({
      id: accountBUser.id,
      accountId: accountBId,
      plan: { name: "Premium", scope: "user" }
    });
    await expect(
      getUser(testPool, accountAId, accountBUser.id)
    ).resolves.toBeNull();
  });

  it("rejects account-scope and unknown plans without creating a user", async () => {
    await expect(
      createUser(testPool, accountAId, {
        planId: predefinedPlanId("Starter")
      })
    ).rejects.toMatchObject<Partial<PlanAssignmentError>>({
      code: "PLAN_SCOPE_MISMATCH"
    });
    await expect(
      createUser(testPool, accountAId, { planId: 999_999 })
    ).rejects.toMatchObject<Partial<PlanAssignmentError>>({
      code: "PLAN_NOT_FOUND"
    });

    const result = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM users"
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("accepts an owned custom user plan and rejects another account's plan", async () => {
    const customPlanResult = await testPool.query<{ id: number }>(
      `
        INSERT INTO plans (
          owner_account_id,
          scope,
          name,
          monthly_limit,
          max_units_per_request
        )
        VALUES ($1, 'user', 'Account A Custom User', 50, 5)
        RETURNING id
      `,
      [accountAId]
    );
    const customPlanId = customPlanResult.rows[0]?.id;

    if (customPlanId === undefined) {
      throw new Error("Custom plan ID was not returned.");
    }

    await expect(
      createUser(testPool, accountAId, { planId: customPlanId })
    ).resolves.toMatchObject({
      accountId: accountAId,
      plan: { id: customPlanId, name: "Account A Custom User" }
    });
    await expect(
      createUser(testPool, accountBId, { planId: customPlanId })
    ).rejects.toMatchObject<Partial<PlanAssignmentError>>({
      code: "PLAN_NOT_FOUND"
    });

    const accountBUsers = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM users WHERE account_id = $1",
      [accountBId]
    );
    expect(accountBUsers.rows[0]?.count).toBe("0");
  });

  it("rolls back failures, releases the client, and allows later work", async () => {
    const singleConnectionPool = new Pool({
      connectionString: databaseUrl,
      options: poolOptions,
      max: 1,
      connectionTimeoutMillis: 1_000
    });

    try {
      await expect(
        createUser(singleConnectionPool, accountAId, {
          planId: predefinedPlanId("Starter")
        })
      ).rejects.toBeInstanceOf(PlanAssignmentError);

      await expect(
        createUser(singleConnectionPool, accountAId)
      ).resolves.toMatchObject({
        accountId: accountAId,
        plan: { name: "Basic" }
      });
    } finally {
      await singleConnectionPool.end();
    }
  });

  it("rejects an unknown account without creating a user", async () => {
    const missingAccountId = randomUUID();

    await expect(
      createUser(testPool, missingAccountId)
    ).rejects.toBeInstanceOf(AccountNotFoundError);

    const result = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM users"
    );
    expect(result.rows[0]?.count).toBe("0");
  });
});
