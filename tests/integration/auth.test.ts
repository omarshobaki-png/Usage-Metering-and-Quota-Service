import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { generateApiKey } from "../../src/modules/accounts/api-key.js";
import {
  provisionAccount,
  type ProvisionedAccount
} from "../../src/modules/accounts/provision-account.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for auth tests.");
}

const schemaName = `auth_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const quotedSchemaName = `"${schemaName}"`;
const poolOptions = `-c search_path=${schemaName}`;
const adminPool = new Pool({ connectionString: databaseUrl });
const testPool = new Pool({
  connectionString: databaseUrl,
  options: poolOptions
});
const testPepper = "authentication-test-pepper";
const apps: FastifyInstance[] = [];
const unusedUserOperations = {
  createUser: async () => {
    throw new Error("User creation is not used by this test.");
  },
  getUser: async () => null
};

let accountA: ProvisionedAccount;
let accountB: ProvisionedAccount;

function createTestApp(pool: Pool = testPool): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => {
      await pool.query("SELECT 1");
    },
    authenticateAccount: createApiKeyAuthenticator(pool, testPepper),
    userOperations: unusedUserOperations,
    logger: false
  });

  apps.push(app);
  return app;
}

async function closeTrackedApp(app: FastifyInstance): Promise<void> {
  const index = apps.indexOf(app);

  if (index >= 0) {
    apps.splice(index, 1);
  }

  await app.close();
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${quotedSchemaName}`);
  await runMigrations(testPool);
  await seedPredefinedPlans(testPool);

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

describe("account API-key authentication", () => {
  it("keeps the health endpoint public", async () => {
    const response = await createTestApp().inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
  });

  it("returns the same generic 401 for missing, empty, malformed, and unknown keys", async () => {
    const app = createTestApp();
    const attempts = [
      undefined,
      "",
      "not-an-api-key",
      generateApiKey()
    ];

    for (const apiKey of attempts) {
      const response = await app.inject({
        method: "GET",
        url: "/account",
        ...(apiKey === undefined
          ? {}
          : { headers: { "x-api-key": apiKey } })
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid API key is required."
        },
        correlationId: expect.any(String)
      });
      if (apiKey !== undefined && apiKey.length > 0) {
        expect(response.body).not.toContain(apiKey);
      }
    }
  });

  it("returns only the account and current plan belonging to each key", async () => {
    const app = createTestApp();
    const responseA = await app.inject({
      method: "GET",
      url: "/account",
      headers: { "x-api-key": accountA.apiKey }
    });
    const responseB = await app.inject({
      method: "GET",
      url: "/account",
      headers: { "x-api-key": accountB.apiKey }
    });

    expect(responseA.statusCode).toBe(200);
    expect(responseA.json()).toEqual({
      account: {
        id: accountA.id,
        name: "Account A",
        plan: {
          id: accountA.planId,
          name: "Starter",
          scope: "account",
          monthlyLimit: 10_000,
          maxUnitsPerRequest: 100,
          revision: 1
        }
      }
    });
    expect(responseB.statusCode).toBe(200);
    expect(responseB.json()).toMatchObject({
      account: {
        id: accountB.id,
        name: "Account B",
        plan: { name: "Pro", scope: "account" }
      }
    });
    expect(responseA.body).not.toContain(accountA.apiKey);
    expect(responseB.body).not.toContain(accountB.apiKey);
    expect(responseA.body).not.toContain("apiKeyDigest");
    expect(responseB.body).not.toContain("apiKeyDigest");
  });

  it("does not let a query parameter override the account authenticated by the key", async () => {
    const response = await createTestApp().inject({
      method: "GET",
      url: `/account?accountId=${accountB.id}`,
      headers: { "x-api-key": accountA.apiKey }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      account: { id: accountA.id, name: "Account A" }
    });
    expect(response.body).not.toContain(accountB.id);
  });

  it("authenticates a persisted key after rebuilding the app and pool", async () => {
    const firstApp = createTestApp();
    const firstResponse = await firstApp.inject({
      method: "GET",
      url: "/account",
      headers: { "x-api-key": accountA.apiKey }
    });

    expect(firstResponse.statusCode).toBe(200);
    await closeTrackedApp(firstApp);

    const restartedPool = new Pool({
      connectionString: databaseUrl,
      options: poolOptions
    });

    try {
      const restartedApp = createTestApp(restartedPool);
      const restartedResponse = await restartedApp.inject({
        method: "GET",
        url: "/account",
        headers: { "x-api-key": accountA.apiKey }
      });

      expect(restartedResponse.statusCode).toBe(200);
      expect(restartedResponse.json()).toMatchObject({
        account: { id: accountA.id, name: "Account A" }
      });
      await closeTrackedApp(restartedApp);
    } finally {
      await restartedPool.end();
    }
  });
});
