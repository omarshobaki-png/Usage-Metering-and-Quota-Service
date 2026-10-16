import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { digestApiKey } from "../../src/modules/accounts/api-key.js";
import {
  AccountProvisioningError,
  provisionAccount
} from "../../src/modules/accounts/provision-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL is required for account tests."
  );
}

const schemaName = `account_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "account-test-pepper-value";

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
});

beforeEach(async () => {
  await testPool.query("DELETE FROM accounts");
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("account provisioning", () => {
  it("creates distinct accounts and stores only their API-key digests", async () => {
    const accountA = await provisionAccount(testPool, {
      name: "Account A",
      apiKeyPepper: testPepper
    });
    const accountB = await provisionAccount(testPool, {
      name: "Account B",
      planName: "Pro",
      apiKeyPepper: testPepper
    });

    expect(accountA.apiKey).toMatch(/^umq_[A-Za-z0-9_-]{43}$/);
    expect(accountB.apiKey).toMatch(/^umq_[A-Za-z0-9_-]{43}$/);
    expect(accountA.apiKey).not.toBe(accountB.apiKey);
    expect(accountA.planName).toBe("Starter");
    expect(accountB.planName).toBe("Pro");

    const stored = await testPool.query<{
      id: string;
      apiKeyDigest: string;
    }>(
      `
        SELECT id, api_key_digest AS "apiKeyDigest"
        FROM accounts
        ORDER BY name
      `
    );

    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]?.apiKeyDigest).toBe(
      digestApiKey(accountA.apiKey, testPepper)
    );
    expect(stored.rows[1]?.apiKeyDigest).toBe(
      digestApiKey(accountB.apiKey, testPepper)
    );
    expect(stored.rows[0]?.apiKeyDigest).not.toBe(accountA.apiKey);
    expect(stored.rows[1]?.apiKeyDigest).not.toBe(accountB.apiKey);
  });

  it("rejects a user-scope plan without creating a partial account", async () => {
    await expect(
      provisionAccount(testPool, {
        name: "Wrong Scope",
        planName: "Basic",
        apiKeyPepper: testPepper
      })
    ).rejects.toThrow(AccountProvisioningError);

    const result = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM accounts"
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("rejects an unknown plan without creating a partial account", async () => {
    await expect(
      provisionAccount(testPool, {
        name: "Missing Plan",
        planName: "Does Not Exist",
        apiKeyPepper: testPepper
      })
    ).rejects.toThrow('Predefined plan "Does Not Exist" does not exist.');

    const result = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM accounts"
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("keeps the account, assignment, and digest across a new pool", async () => {
    const created = await provisionAccount(testPool, {
      name: "Persistent Account",
      planName: "Pro",
      apiKeyPepper: testPepper
    });

    await expect(runMigrations(testPool)).resolves.toEqual([]);
    await expect(seedPredefinedPlans(testPool)).resolves.toBe(0);

    const restartedPool = new Pool({
      connectionString: databaseUrl,
      options: poolOptions
    });

    try {
      const result = await restartedPool.query<{
        id: string;
        name: string;
        apiKeyDigest: string;
        planName: string;
      }>(
        `
          SELECT
            accounts.id,
            accounts.name,
            accounts.api_key_digest AS "apiKeyDigest",
            plans.name AS "planName"
          FROM accounts
          JOIN plans ON plans.id = accounts.account_plan_id
          WHERE accounts.id = $1
        `,
        [created.id]
      );

      expect(result.rows[0]).toEqual({
        id: created.id,
        name: "Persistent Account",
        apiKeyDigest: digestApiKey(created.apiKey, testPepper),
        planName: "Pro"
      });
    } finally {
      await restartedPool.end();
    }
  });
});
