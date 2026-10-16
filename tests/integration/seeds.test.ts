import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import {
  predefinedPlans,
  seedPredefinedPlans
} from "../../src/db/seed.js";
import { listPredefinedPlans } from "../../src/modules/plans/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for seed tests.");
}

const schemaName = `seed_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName}`
});

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
});

beforeEach(async () => {
  await testPool.query("TRUNCATE TABLE plans, accounts CASCADE");
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("predefined plan seeds", () => {
  it("inserts the four predefined plans exactly once", async () => {
    await expect(seedPredefinedPlans(testPool)).resolves.toBe(4);
    await expect(seedPredefinedPlans(testPool)).resolves.toBe(0);

    const result = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM plans WHERE owner_account_id IS NULL"
    );

    expect(result.rows[0]?.count).toBe("4");
  });

  it("preserves custom plans and assignments on later seed runs", async () => {
    await seedPredefinedPlans(testPool);

    const accountId = randomUUID();
    const userId = randomUUID();
    const starter = predefinedPlans.find((plan) => plan.name === "Starter");
    const basic = predefinedPlans.find((plan) => plan.name === "Basic");

    if (starter === undefined || basic === undefined) {
      throw new Error("Required predefined plans are missing from the seed list.");
    }

    await testPool.query(
      `
        INSERT INTO accounts (id, name, api_key_digest, account_plan_id)
        VALUES ($1, 'Seed Test Account', $2, $3)
      `,
      [accountId, `digest-${accountId}`, starter.id]
    );
    const customPlanResult = await testPool.query<{ id: number }>(
      `
        INSERT INTO plans (
          owner_account_id, scope, name, monthly_limit, max_units_per_request
        )
        VALUES ($1, 'user', 'Custom', 50, 5)
        RETURNING id
      `,
      [accountId]
    );
    const customPlanId = customPlanResult.rows[0]?.id;

    if (customPlanId === undefined) {
      throw new Error("Custom plan ID was not returned.");
    }
    await testPool.query(
      `
        INSERT INTO users (id, account_id, user_plan_id)
        VALUES ($1, $2, $3)
      `,
      [userId, accountId, customPlanId]
    );

    await expect(seedPredefinedPlans(testPool)).resolves.toBe(0);

    const user = await testPool.query<{ user_plan_id: number }>(
      "SELECT user_plan_id FROM users WHERE id = $1",
      [userId]
    );
    const customPlan = await testPool.query<{ monthly_limit: number }>(
      "SELECT monthly_limit FROM plans WHERE id = $1",
      [customPlanId]
    );

    expect(user.rows[0]?.user_plan_id).toBe(customPlanId);
    expect(customPlan.rows[0]?.monthly_limit).toBe(50);
  });

  it("lists predefined plans for one scope", async () => {
    await seedPredefinedPlans(testPool);

    const accountPlans = await listPredefinedPlans(testPool, "account");
    const userPlans = await listPredefinedPlans(testPool, "user");

    expect(accountPlans.map((plan) => plan.name)).toEqual(["Pro", "Starter"]);
    expect(userPlans.map((plan) => plan.name)).toEqual(["Basic", "Premium"]);
  });
});
