import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  PredefinedPlanReadOnlyError,
  RequestIdConflictError
} from "../../src/shared/errors.js";
import {
  consumeBodySchema,
  createCustomPlanBodySchema,
  createUserBodySchema,
  MAX_PLAN_NAME_LENGTH,
  MAX_QUANTITY,
  MAX_REQUEST_ID_LENGTH,
  planAssignmentBodySchema,
  planLimitSchema,
  requestIdSchema,
  unitsSchema,
  updateCustomPlanBodySchema
} from "../../src/shared/validation.js";

const validApiKey = `umq_${"a".repeat(43)}`;
const accountId = randomUUID();
const userId = randomUUID();
const apps: FastifyInstance[] = [];

function createTestApp(onCreate: () => void): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => undefined,
    authenticateAccount: async () => ({
      id: accountId,
      name: "Validation Account",
      plan: {
        id: 1,
        name: "Starter",
        scope: "account",
        monthlyLimit: 10_000,
        maxUnitsPerRequest: 100,
        revision: 1
      }
    }),
    userOperations: {
      createUser: async (authenticatedAccountId) => {
        onCreate();
        return {
          id: userId,
          accountId: authenticatedAccountId,
          createdAt: new Date("2026-10-16T00:00:00.000Z"),
          plan: {
            id: 3,
            name: "Basic",
            scope: "user",
            monthlyLimit: 1_000,
            maxUnitsPerRequest: 20,
            revision: 1
          }
        };
      },
      getUser: async () => null
    },
    logger: false
  });

  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("quantity validation", () => {
  it.each([1, 20, MAX_QUANTITY])("accepts units=%s", (units) => {
    expect(unitsSchema.safeParse(units).success).toBe(true);
  });

  it.each([
    0,
    -1,
    1.5,
    "4",
    null,
    undefined,
    MAX_QUANTITY + 1,
    Number.MAX_SAFE_INTEGER + 1
  ])("rejects units=%s", (units) => {
    expect(unitsSchema.safeParse(units).success).toBe(false);
  });

  it.each([0, 1, MAX_QUANTITY])("accepts plan limit=%s", (limit) => {
    expect(planLimitSchema.safeParse(limit).success).toBe(true);
  });

  it.each([-1, 1.5, "4", null, undefined, MAX_QUANTITY + 1])(
    "rejects plan limit=%s",
    (limit) => {
      expect(planLimitSchema.safeParse(limit).success).toBe(false);
    }
  );
});

describe("request identifier validation", () => {
  it.each(["doc-2026:01", "request_1", "a.b:c-d"])(
    "accepts requestId=%s",
    (requestId) => {
      expect(requestIdSchema.safeParse(requestId).success).toBe(true);
    }
  );

  it.each([
    "",
    "a".repeat(MAX_REQUEST_ID_LENGTH + 1),
    "contains space",
    "contains/slash",
    "contains@email"
  ])("rejects requestId=%s", (requestId) => {
    expect(requestIdSchema.safeParse(requestId).success).toBe(false);
  });
});

describe("mutation body validation", () => {
  it("accepts a complete consume body without coercing values", () => {
    expect(
      consumeBodySchema.safeParse({
        userId,
        units: 4,
        requestId: "doc-2026:01"
      }).success
    ).toBe(true);
    expect(
      consumeBodySchema.safeParse({
        userId,
        units: "4",
        requestId: "doc-2026:01"
      }).success
    ).toBe(false);
  });

  it("requires every consume field and rejects ownership overrides", () => {
    expect(
      consumeBodySchema.safeParse({ units: 4, requestId: "request-1" }).success
    ).toBe(false);
    expect(
      consumeBodySchema.safeParse({
        userId,
        units: 4,
        requestId: "request-1",
        accountId
      }).success
    ).toBe(false);
  });

  it("validates strict custom-plan creation and update bodies", () => {
    expect(
      createCustomPlanBodySchema.safeParse({
        name: "No monthly allowance",
        scope: "user",
        monthlyLimit: 0,
        requestLimit: 5
      }).success
    ).toBe(true);
    expect(
      createCustomPlanBodySchema.safeParse({
        name: "Invalid",
        scope: "user",
        monthlyLimit: -1,
        requestLimit: 5
      }).success
    ).toBe(false);
    expect(
      createCustomPlanBodySchema.safeParse({
        name: "x".repeat(MAX_PLAN_NAME_LENGTH + 1),
        scope: "user",
        monthlyLimit: 10,
        requestLimit: 5
      }).success
    ).toBe(false);
    expect(updateCustomPlanBodySchema.safeParse({}).success).toBe(false);
    expect(
      updateCustomPlanBodySchema.safeParse({ scope: "account" }).success
    ).toBe(false);
  });

  it("rejects unknown user and assignment fields", () => {
    expect(createUserBodySchema.safeParse({ accountId }).success).toBe(false);
    expect(
      planAssignmentBodySchema.safeParse({ planId: 3, accountId }).success
    ).toBe(false);
  });
});

describe("stable future error mappings", () => {
  it("names predefined-plan edits and request-ID conflicts distinctly", () => {
    expect(new PredefinedPlanReadOnlyError()).toMatchObject({
      statusCode: 403,
      code: "PREDEFINED_PLAN_READ_ONLY"
    });
    expect(new RequestIdConflictError()).toMatchObject({
      statusCode: 409,
      code: "REQUEST_ID_CONFLICT"
    });
  });
});

describe("HTTP validation", () => {
  it("returns the safe JSON envelope for malformed JSON without writing", async () => {
    let createCalls = 0;
    const response = await createTestApp(() => {
      createCalls += 1;
    }).inject({
      method: "POST",
      url: "/users",
      headers: {
        "content-type": "application/json",
        "x-api-key": validApiKey
      },
      payload: '{"planId":'
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON."
      },
      correlationId: expect.any(String)
    });
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("Zod");
    expect(createCalls).toBe(0);
  });

  it.each([
    { planId: "4" },
    { planId: 1.5 },
    { accountId },
    "null",
    []
  ])("rejects invalid user body %# without writing", async (payload) => {
    let createCalls = 0;
    const response = await createTestApp(() => {
      createCalls += 1;
    }).inject({
      method: "POST",
      url: "/users",
      headers: {
        "content-type": "application/json",
        "x-api-key": validApiKey
      },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Request body is invalid."
      },
      correlationId: expect.any(String)
    });
    expect(createCalls).toBe(0);
  });

  it("authenticates before a valid user mutation", async () => {
    let createCalls = 0;
    const response = await createTestApp(() => {
      createCalls += 1;
    }).inject({
      method: "POST",
      url: "/users",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
    expect(createCalls).toBe(0);
  });
});
