import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { predefinedPlans, seedPredefinedPlans } from "../../src/db/seed.js";
import {
  createCustomPlan,
  updateCustomPlan
} from "../../src/modules/plans/service.js";
import { createUser } from "../../src/modules/users/service.js";
import {
  createTwoAccountFixture,
  type TwoAccountFixture
} from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL is required for assignment tests."
  );
}

const schemaName = `assignment_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "assignment-route-test-pepper";
const apps: FastifyInstance[] = [];

let fixture: TwoAccountFixture;

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

describe("plan assignment routes", () => {
  it("requires authentication for account and user assignment", async () => {
    const app = createTestApp();
    const accountResponse = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      payload: { planId: predefinedPlanId("Pro") }
    });
    const userResponse = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userA.id}/plan`,
      payload: { planId: predefinedPlanId("Premium") }
    });

    expect(accountResponse.statusCode).toBe(401);
    expect(userResponse.statusCode).toBe(401);
    expect(accountResponse.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
    expect(userResponse.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
  });

  it("switches an account to an owned custom plan and back", async () => {
    const customPlan = await createCustomPlan(testPool, fixture.accountA.id, {
      name: "A Account Custom",
      scope: "account",
      monthlyLimit: 30,
      requestLimit: 10
    });
    const app = createTestApp();
    const customResponse = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: customPlan.id }
    });
    const customRead = await app.inject({
      method: "GET",
      url: "/account",
      headers: { "x-api-key": fixture.accountA.apiKey }
    });

    expect(customResponse.statusCode).toBe(200);
    expect(customResponse.json()).toMatchObject({
      account: {
        id: fixture.accountA.id,
        plan: {
          id: customPlan.id,
          name: "A Account Custom",
          scope: "account",
          monthlyLimit: 30,
          maxUnitsPerRequest: 10,
          revision: 1
        }
      }
    });
    expect(customRead.json()).toEqual(customResponse.json());

    const starterResponse = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Starter") }
    });

    expect(starterResponse.statusCode).toBe(200);
    expect(starterResponse.json()).toMatchObject({
      account: { plan: { name: "Starter", scope: "account" } }
    });
  });

  it("assigns one custom definition to two users and exposes later edits", async () => {
    const secondUser = await createUser(testPool, fixture.accountA.id);
    const app = createTestApp();

    for (const userId of [fixture.userA.id, secondUser.id]) {
      const response = await app.inject({
        method: "PATCH",
        url: `/users/${userId}/plan`,
        headers: { "x-api-key": fixture.accountA.apiKey },
        payload: { planId: fixture.customPlanA.id }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: {
          id: userId,
          plan: { id: fixture.customPlanA.id, name: "Account A Custom User" }
        }
      });
    }

    await updateCustomPlan(
      testPool,
      fixture.accountA.id,
      fixture.customPlanA.id,
      { requestLimit: 9 }
    );

    for (const userId of [fixture.userA.id, secondUser.id]) {
      const response = await app.inject({
        method: "GET",
        url: `/users/${userId}`,
        headers: { "x-api-key": fixture.accountA.apiKey }
      });

      expect(response.json()).toMatchObject({
        user: {
          id: userId,
          plan: {
            id: fixture.customPlanA.id,
            maxUnitsPerRequest: 9,
            revision: 2
          }
        }
      });
    }

    const backToBasic = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userA.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Basic") }
    });
    const secondUserRead = await app.inject({
      method: "GET",
      url: `/users/${secondUser.id}`,
      headers: { "x-api-key": fixture.accountA.apiKey }
    });

    expect(backToBasic.statusCode).toBe(200);
    expect(backToBasic.json()).toMatchObject({
      user: { id: fixture.userA.id, plan: { name: "Basic" } }
    });
    expect(secondUserRead.json()).toMatchObject({
      user: {
        id: secondUser.id,
        plan: { id: fixture.customPlanA.id, revision: 2 }
      }
    });
  });

  it("rejects wrong-scope, foreign-plan, and foreign-user assignments", async () => {
    const foreignAccountPlan = await createCustomPlan(
      testPool,
      fixture.accountB.id,
      {
        name: "B Account Private",
        scope: "account",
        monthlyLimit: 100,
        requestLimit: 20
      }
    );
    const app = createTestApp();
    const accountWrongScope = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Basic") }
    });
    const userWrongScope = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userA.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Starter") }
    });
    const foreignAccountPlanResponse = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: foreignAccountPlan.id }
    });
    const foreignUserPlanResponse = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userA.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: fixture.customPlanB.id }
    });
    const foreignUserResponse = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userB.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: fixture.customPlanA.id }
    });

    expect(accountWrongScope.statusCode).toBe(422);
    expect(userWrongScope.statusCode).toBe(422);
    expect(accountWrongScope.json()).toMatchObject({
      error: { code: "PLAN_SCOPE_MISMATCH" }
    });
    expect(userWrongScope.json()).toMatchObject({
      error: { code: "PLAN_SCOPE_MISMATCH" }
    });
    expect(foreignAccountPlanResponse.statusCode).toBe(404);
    expect(foreignUserPlanResponse.statusCode).toBe(404);
    expect(foreignUserResponse.statusCode).toBe(404);
    expect(foreignAccountPlanResponse.json()).toMatchObject({
      error: { code: "PLAN_NOT_FOUND" }
    });
    expect(foreignUserPlanResponse.json()).toMatchObject({
      error: { code: "PLAN_NOT_FOUND" }
    });
    expect(foreignUserResponse.json()).toMatchObject({
      error: { code: "USER_NOT_FOUND" }
    });

    const accountRead = await app.inject({
      method: "GET",
      url: "/account",
      headers: { "x-api-key": fixture.accountA.apiKey }
    });
    const userARead = await app.inject({
      method: "GET",
      url: `/users/${fixture.userA.id}`,
      headers: { "x-api-key": fixture.accountA.apiKey }
    });
    const userBRead = await app.inject({
      method: "GET",
      url: `/users/${fixture.userB.id}`,
      headers: { "x-api-key": fixture.accountB.apiKey }
    });

    expect(accountRead.json()).toMatchObject({
      account: { plan: { name: "Starter" } }
    });
    expect(userARead.json()).toMatchObject({
      user: { plan: { name: "Basic" } }
    });
    expect(userBRead.json()).toMatchObject({
      user: { plan: { name: "Basic" } }
    });
  });

  it("switches plans without changing usage or historical decisions", async () => {
    const usageMonth = "2026-10-01";
    const snapshot = {
      marker: "original rules",
      accountPlanId: fixture.accountA.planId,
      userPlanId: fixture.userA.plan.id
    };

    await testPool.query(
      `
        INSERT INTO account_monthly_usage (
          account_id, usage_month, consumed_units
        )
        VALUES ($1, $2, 7)
      `,
      [fixture.accountA.id, usageMonth]
    );
    await testPool.query(
      `
        INSERT INTO user_monthly_usage (
          account_id, user_id, usage_month, consumed_units
        )
        VALUES ($1, $2, $3, 7)
      `,
      [fixture.accountA.id, fixture.userA.id, usageMonth]
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
        VALUES ($1, 'before-switch', $2, 7, $3, true, 'accepted', $4, $5, 1, 1, $6::jsonb)
      `,
      [
        fixture.accountA.id,
        fixture.userA.id,
        usageMonth,
        fixture.accountA.planId,
        fixture.userA.plan.id,
        JSON.stringify(snapshot)
      ]
    );

    const app = createTestApp();
    const accountSwitch = await app.inject({
      method: "PATCH",
      url: "/account/plan",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Pro") }
    });
    const userSwitch = await app.inject({
      method: "PATCH",
      url: `/users/${fixture.userA.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: predefinedPlanId("Premium") }
    });

    expect(accountSwitch.statusCode).toBe(200);
    expect(userSwitch.statusCode).toBe(200);
    expect(accountSwitch.json()).toMatchObject({
      account: { plan: { name: "Pro" } }
    });
    expect(userSwitch.json()).toMatchObject({
      user: { plan: { name: "Premium" } }
    });

    const preserved = await testPool.query<{
      accountConsumed: number;
      userConsumed: number;
      recordedAccountPlanId: number;
      recordedUserPlanId: number;
      decisionSnapshot: typeof snapshot;
    }>(
      `
        SELECT
          account_usage.consumed_units AS "accountConsumed",
          user_usage.consumed_units AS "userConsumed",
          decisions.account_plan_id AS "recordedAccountPlanId",
          decisions.user_plan_id AS "recordedUserPlanId",
          decisions.decision_snapshot AS "decisionSnapshot"
        FROM request_decisions AS decisions
        JOIN account_monthly_usage AS account_usage
          ON account_usage.account_id = decisions.account_id
         AND account_usage.usage_month = decisions.processed_month
        JOIN user_monthly_usage AS user_usage
          ON user_usage.account_id = decisions.account_id
         AND user_usage.user_id = decisions.user_id
         AND user_usage.usage_month = decisions.processed_month
        WHERE decisions.account_id = $1
          AND decisions.request_id = 'before-switch'
      `,
      [fixture.accountA.id]
    );

    expect(preserved.rows[0]).toEqual({
      accountConsumed: 7,
      userConsumed: 7,
      recordedAccountPlanId: fixture.accountA.planId,
      recordedUserPlanId: fixture.userA.plan.id,
      decisionSnapshot: snapshot
    });
  });
});
