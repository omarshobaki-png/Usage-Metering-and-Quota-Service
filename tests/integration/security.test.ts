import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import {
  createTwoAccountFixture,
  type TwoAccountFixture
} from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL is required for security tests."
  );
}

const schemaName = `security_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "tenant-security-test-pepper";
const apps: FastifyInstance[] = [];

let fixture: TwoAccountFixture;

function createTestApp(): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => {
      await testPool.query("SELECT 1");
    },
    authenticateAccount: createApiKeyAuthenticator(testPool, testPepper),
    userOperations: {
      createUser: async (accountId, input) =>
        createUser(testPool, accountId, input),
      getUser: async (accountId, userId) =>
        getUser(testPool, accountId, userId)
    },
    logger: false
  });

  apps.push(app);
  return app;
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);
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

describe("user tenant isolation", () => {
  it("requires authentication before creating or reading users", async () => {
    const app = createTestApp();
    const createResponse = await app.inject({
      method: "POST",
      url: "/users",
      payload: {}
    });
    const readResponse = await app.inject({
      method: "GET",
      url: `/users/${fixture.userA.id}`
    });

    for (const response of [createResponse, readResponse]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "UNAUTHORIZED" }
      });
    }
  });

  it("lets each account read its own user", async () => {
    const app = createTestApp();
    const responseA = await app.inject({
      method: "GET",
      url: `/users/${fixture.userA.id}`,
      headers: { "x-api-key": fixture.accountA.apiKey }
    });
    const responseB = await app.inject({
      method: "GET",
      url: `/users/${fixture.userB.id}`,
      headers: { "x-api-key": fixture.accountB.apiKey }
    });

    expect(responseA.statusCode).toBe(200);
    expect(responseA.json()).toMatchObject({
      user: { id: fixture.userA.id, accountId: fixture.accountA.id }
    });
    expect(responseB.statusCode).toBe(200);
    expect(responseB.json()).toMatchObject({
      user: { id: fixture.userB.id, accountId: fixture.accountB.id }
    });
  });

  it("returns the same 404 for a foreign user and an unknown user", async () => {
    const app = createTestApp();
    const foreignResponse = await app.inject({
      method: "GET",
      url: `/users/${fixture.userB.id}`,
      headers: { "x-api-key": fixture.accountA.apiKey }
    });
    const unknownResponse = await app.inject({
      method: "GET",
      url: `/users/${randomUUID()}`,
      headers: { "x-api-key": fixture.accountA.apiKey }
    });

    expect(foreignResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(foreignResponse.json().error).toEqual(unknownResponse.json().error);
    expect(foreignResponse.body).not.toContain(fixture.accountB.name);
    expect(foreignResponse.body).not.toContain(fixture.userB.id);
  });

  it("rejects an ownership override without creating a user", async () => {
    const before = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM users"
    );
    const response = await createTestApp().inject({
      method: "POST",
      url: "/users",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { accountId: fixture.accountB.id }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" }
    });

    const after = await testPool.query<{ count: string }>(
      "SELECT count(*) FROM users"
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("validates that a selected initial plan has user scope", async () => {
    const response = await createTestApp().inject({
      method: "POST",
      url: "/users",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: fixture.accountA.planId }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "PLAN_SCOPE_MISMATCH" }
    });
  });

  it("hides a foreign custom plan before checking its scope", async () => {
    const foreignPlanResult = await testPool.query<{ id: number }>(
      `
        INSERT INTO plans (
          owner_account_id,
          scope,
          name,
          monthly_limit,
          max_units_per_request
        )
        VALUES ($1, 'account', 'Account B Private Plan', 50, 5)
        RETURNING id
      `,
      [fixture.accountB.id]
    );
    const foreignPlanId = foreignPlanResult.rows[0]?.id;

    if (foreignPlanId === undefined) {
      throw new Error("Foreign custom plan ID was not returned.");
    }

    const app = createTestApp();
    const foreignResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: foreignPlanId }
    });
    const unknownResponse = await app.inject({
      method: "POST",
      url: "/users",
      headers: { "x-api-key": fixture.accountA.apiKey },
      payload: { planId: 2_000_000_000 }
    });

    expect(foreignResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(foreignResponse.json().error).toEqual(unknownResponse.json().error);
    expect(foreignResponse.body).not.toContain("Account B Private Plan");
    expect(foreignResponse.body).not.toContain("account scope");
  });

  it("rejects a suspicious identifier without changing the SQL query", async () => {
    const response = await createTestApp().inject({
      method: "GET",
      url: "/users/'%20OR%201=1--",
      headers: { "x-api-key": fixture.accountA.apiKey }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "USER_NOT_FOUND" }
    });
    expect(response.body).not.toContain(fixture.userA.id);
    expect(response.body).not.toContain(fixture.userB.id);
  });
});
