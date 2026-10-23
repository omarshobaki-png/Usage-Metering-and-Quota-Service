import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { predefinedPlans, seedPredefinedPlans } from "../../src/db/seed.js";
import {
  provisionAccount,
  type ProvisionedAccount
} from "../../src/modules/accounts/provision-account.js";
import { createCustomPlan, getPlan } from "../../src/modules/plans/service.js";
import { createUser } from "../../src/modules/users/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for plan tests.");
}

const schemaName = `plan_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "plan-route-test-pepper";
const apps: FastifyInstance[] = [];

let accountA: ProvisionedAccount;
let accountB: ProvisionedAccount;

function predefinedPlanId(name: string): number {
  const plan = predefinedPlans.find((candidate) => candidate.name === name);

  if (plan === undefined) {
    throw new Error(`Missing predefined plan: ${name}`);
  }

  return plan.id;
}

function createTestApp(): FastifyInstance {
  const app = buildApp({
    ...createAppOperations(testPool, testPepper),
    logger: false
  });

  apps.push(app);
  return app;
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

  accountA = await provisionAccount(testPool, {
    name: "Account A",
    apiKeyPepper: testPepper
  });
  accountB = await provisionAccount(testPool, {
    name: "Account B",
    planName: "Pro",
    apiKeyPepper: testPepper
  });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

afterAll(async () => {
  await testPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`);
  await adminPool.end();
});

describe("custom plan routes", () => {
  it("creates account- and user-scope plans owned by the caller", async () => {
    const app = createTestApp();
    const accountPlanResponse = await app.inject({
      method: "POST",
      url: "/plans",
      headers: { "x-api-key": accountA.apiKey },
      payload: {
        name: "  Account Burst  ",
        scope: "account",
        monthlyLimit: 30,
        requestLimit: 100
      }
    });
    const userPlanResponse = await app.inject({
      method: "POST",
      url: "/plans",
      headers: { "x-api-key": accountA.apiKey },
      payload: {
        name: "User Small",
        scope: "user",
        monthlyLimit: 10,
        requestLimit: 5
      }
    });

    expect(accountPlanResponse.statusCode).toBe(201);
    expect(accountPlanResponse.json()).toMatchObject({
      plan: {
        name: "Account Burst",
        scope: "account",
        monthlyLimit: 30,
        requestLimit: 100,
        revision: 1,
        owner: "account"
      }
    });
    expect(userPlanResponse.statusCode).toBe(201);
    expect(userPlanResponse.json()).toMatchObject({
      plan: {
        name: "User Small",
        scope: "user",
        monthlyLimit: 10,
        requestLimit: 5,
        revision: 1,
        owner: "account"
      }
    });

    const stored = await testPool.query<{ ownerAccountId: string }>(
      `
        SELECT owner_account_id AS "ownerAccountId"
        FROM plans
        WHERE id = ANY($1::integer[])
        ORDER BY id
      `,
      [[accountPlanResponse.json().plan.id, userPlanResponse.json().plan.id]]
    );
    expect(stored.rows.map((row) => row.ownerAccountId)).toEqual([
      accountA.id,
      accountA.id
    ]);
  });

  it("lists only predefined and owned plans and supports scope filtering", async () => {
    const accountACustom = await createCustomPlan(testPool, accountA.id, {
      name: "A User Plan",
      scope: "user",
      monthlyLimit: 25,
      requestLimit: 5
    });
    await createCustomPlan(testPool, accountA.id, {
      name: "A Account Plan",
      scope: "account",
      monthlyLimit: 50,
      requestLimit: 10
    });
    await createCustomPlan(testPool, accountB.id, {
      name: "B Private Plan",
      scope: "user",
      monthlyLimit: 100,
      requestLimit: 10
    });

    const app = createTestApp();
    const allAResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { "x-api-key": accountA.apiKey }
    });
    const allBResponse = await app.inject({
      method: "GET",
      url: "/plans",
      headers: { "x-api-key": accountB.apiKey }
    });
    const userAResponse = await app.inject({
      method: "GET",
      url: "/plans?scope=user",
      headers: { "x-api-key": accountA.apiKey }
    });
    const ownedReadResponse = await app.inject({
      method: "GET",
      url: `/plans/${accountACustom.id}`,
      headers: { "x-api-key": accountA.apiKey }
    });
    const foreignReadResponse = await app.inject({
      method: "GET",
      url: `/plans/${accountACustom.id}`,
      headers: { "x-api-key": accountB.apiKey }
    });
    const unknownReadResponse = await app.inject({
      method: "GET",
      url: "/plans/2000000000",
      headers: { "x-api-key": accountB.apiKey }
    });

    expect(allAResponse.statusCode).toBe(200);
    expect(allAResponse.json().plans).toHaveLength(6);
    expect(allAResponse.body).not.toContain("B Private Plan");
    expect(allBResponse.json().plans).toHaveLength(5);
    expect(allBResponse.body).not.toContain("A User Plan");
    expect(allBResponse.body).not.toContain("A Account Plan");
    expect(
      userAResponse.json().plans.map((plan: { name: string }) => plan.name)
    ).toEqual(["Basic", "Premium", "A User Plan"]);
    expect(ownedReadResponse.statusCode).toBe(200);
    expect(ownedReadResponse.json()).toMatchObject({
      plan: { id: accountACustom.id, owner: "account" }
    });
    expect(foreignReadResponse.statusCode).toBe(404);
    expect(unknownReadResponse.statusCode).toBe(404);
    expect(foreignReadResponse.json().error).toEqual(
      unknownReadResponse.json().error
    );
  });

  it("updates only an owned custom plan and increments its revision", async () => {
    const customPlan = await createCustomPlan(testPool, accountA.id, {
      name: "Original",
      scope: "account",
      monthlyLimit: 30,
      requestLimit: 10
    });
    const app = createTestApp();
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountA.apiKey },
      payload: {
        name: "Updated",
        monthlyLimit: 50,
        requestLimit: 20
      }
    });
    const readResponse = await app.inject({
      method: "GET",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountA.apiKey }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      plan: {
        id: customPlan.id,
        name: "Updated",
        scope: "account",
        monthlyLimit: 50,
        requestLimit: 20,
        revision: 2,
        owner: "account"
      }
    });
    expect(readResponse.json()).toEqual(updateResponse.json());

    const predefinedResponse = await app.inject({
      method: "PATCH",
      url: `/plans/${predefinedPlanId("Starter")}`,
      headers: { "x-api-key": accountA.apiKey },
      payload: { monthlyLimit: 1 }
    });
    const foreignResponse = await app.inject({
      method: "PATCH",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountB.apiKey },
      payload: { monthlyLimit: 1 }
    });

    expect(predefinedResponse.statusCode).toBe(403);
    expect(predefinedResponse.json()).toMatchObject({
      error: { code: "PREDEFINED_PLAN_READ_ONLY" }
    });
    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toMatchObject({
      error: { code: "PLAN_NOT_FOUND" }
    });

    await expect(getPlan(testPool, accountA.id, customPlan.id)).resolves.toMatchObject({
      monthlyLimit: 50,
      revision: 2
    });
  });

  it("rejects invalid plan bodies without inserting or updating rows", async () => {
    const customPlan = await createCustomPlan(testPool, accountA.id, {
      name: "Unchanged",
      scope: "user",
      monthlyLimit: 10,
      requestLimit: 5
    });
    const app = createTestApp();
    const before = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM plans WHERE owner_account_id = $1",
      [accountA.id]
    );
    const invalidCreates = [
      { name: "Negative", scope: "user", monthlyLimit: -1, requestLimit: 1 },
      { name: "Fraction", scope: "user", monthlyLimit: 1.5, requestLimit: 1 },
      { name: "String", scope: "user", monthlyLimit: "10", requestLimit: 1 },
      {
        name: "Unknown",
        scope: "user",
        monthlyLimit: 10,
        requestLimit: 1,
        ownerAccountId: accountB.id
      }
    ];

    for (const payload of invalidCreates) {
      const response = await app.inject({
        method: "POST",
        url: "/plans",
        headers: { "x-api-key": accountA.apiKey },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" }
      });
    }

    const emptyPatch = await app.inject({
      method: "PATCH",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountA.apiKey },
      payload: {}
    });
    const scopePatch = await app.inject({
      method: "PATCH",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountA.apiKey },
      payload: { scope: "account" }
    });
    const after = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM plans WHERE owner_account_id = $1",
      [accountA.id]
    );

    expect(emptyPatch.statusCode).toBe(400);
    expect(scopePatch.statusCode).toBe(400);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    await expect(getPlan(testPool, accountA.id, customPlan.id)).resolves.toMatchObject({
      name: "Unchanged",
      scope: "user",
      monthlyLimit: 10,
      revision: 1
    });
  });

  it("preserves assignments, usage, and decision snapshots during an update", async () => {
    const customPlan = await createCustomPlan(testPool, accountA.id, {
      name: "Assigned User Plan",
      scope: "user",
      monthlyLimit: 20,
      requestLimit: 10
    });
    const user = await createUser(testPool, accountA.id, {
      planId: customPlan.id
    });
    const usageMonth = "2026-10-01";
    const decisionSnapshot = {
      marker: "must remain unchanged",
      userPlanRevision: 1
    };

    await testPool.query(
      `
        INSERT INTO account_monthly_usage (
          account_id, usage_month, consumed_units
        )
        VALUES ($1, $2, 7)
      `,
      [accountA.id, usageMonth]
    );
    await testPool.query(
      `
        INSERT INTO user_monthly_usage (
          account_id, user_id, usage_month, consumed_units
        )
        VALUES ($1, $2, $3, 7)
      `,
      [accountA.id, user.id, usageMonth]
    );
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
        VALUES ($1, 'preserved-decision', $2, 7, $3, true, 'accepted', $4, $5, 1, 1, $6::jsonb)
      `,
      [
        accountA.id,
        user.id,
        usageMonth,
        accountA.planId,
        customPlan.id,
        JSON.stringify(decisionSnapshot)
      ]
    );

    const response = await createTestApp().inject({
      method: "PATCH",
      url: `/plans/${customPlan.id}`,
      headers: { "x-api-key": accountA.apiKey },
      payload: { monthlyLimit: 50 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plan: { monthlyLimit: 50, revision: 2 }
    });

    const preserved = await testPool.query<{
      userPlanId: number;
      accountConsumed: number;
      userConsumed: number;
      userPlanRevision: number;
      decisionSnapshot: typeof decisionSnapshot;
    }>(
      `
        SELECT
          users.user_plan_id AS "userPlanId",
          account_usage.consumed_units AS "accountConsumed",
          user_usage.consumed_units AS "userConsumed",
          decisions.user_plan_revision AS "userPlanRevision",
          decisions.decision_snapshot AS "decisionSnapshot"
        FROM users
        JOIN account_monthly_usage AS account_usage
          ON account_usage.account_id = users.account_id
        JOIN user_monthly_usage AS user_usage
          ON user_usage.account_id = users.account_id
         AND user_usage.user_id = users.id
        JOIN request_decisions AS decisions
          ON decisions.account_id = users.account_id
         AND decisions.user_id = users.id
        WHERE users.id = $1
      `,
      [user.id]
    );

    expect(preserved.rows[0]).toEqual({
      userPlanId: customPlan.id,
      accountConsumed: 7,
      userConsumed: 7,
      userPlanRevision: 1,
      decisionSnapshot
    });
  });
});
