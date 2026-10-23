import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { consume } from "../../src/modules/usage/consume.js";
import {
  consumptionDecisionSchema,
  type ConsumptionDecision
} from "../../src/modules/usage/contract.js";
import { RequestIdConflictError } from "../../src/shared/errors.js";
import { historyQuerySchema, MAX_QUANTITY, usageQuerySchema } from "../../src/shared/validation.js";

const validApiKey = `umq_${"a".repeat(43)}`;
const accountId = randomUUID();
const ownedUserId = randomUUID();
const foreignUserId = randomUUID();
const unknownUserId = randomUUID();
const apps: FastifyInstance[] = [];
const pool = new Pool();
const connectSpy = vi.spyOn(pool, "connect").mockImplementation(() => {
  throw new Error("These contract tests must not access the database.");
});

function decision(
  overrides: Partial<ConsumptionDecision> = {}
): ConsumptionDecision {
  return {
    requestId: "consume-1",
    userId: ownedUserId,
    units: 4,
    accepted: true,
    processedAt: "2026-10-16T12:30:00.000Z",
    month: "2026-10",
    account: {
      consumed: 4,
      remaining: 9_996,
      plan: { id: 1, revision: 1 }
    },
    user: {
      consumed: 4,
      remaining: 996,
      plan: { id: 3, revision: 1 }
    },
    blockedBy: null,
    ...overrides
  } as ConsumptionDecision;
}

function createTestApp(
  consumeOperation: (
    authenticatedAccountId: string,
    input: unknown
  ) => Promise<ConsumptionDecision | null> = (authenticatedId, input) => consume(pool, authenticatedId, input)
): FastifyInstance {
  const app = buildApp({
    checkDatabase: async () => undefined,
    authenticateAccount: async () => ({
      id: accountId,
      name: "Consumption Contract Account",
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
      createUser: async () => {
        throw new Error("Not used by these tests.");
      },
      getUser: async () => null
    },
    consumptionOperations: { consume: consumeOperation },
    logger: false
  });

  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  connectSpy.mockClear();
});

afterAll(async () => pool.end());

describe("consumption response contract", () => {
  it.each(["0001-01", "2026-10", "9999-12"])("accepts supported month %s across decisions and queries", (month) => {
    expect(consumptionDecisionSchema.safeParse(decision({ month })).success).toBe(true);
    expect(usageQuerySchema.safeParse({ month }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ month }).success).toBe(true);
  });

  it.each(["0000-01", "2026-00", "2026-13", "2026-1", "10000-01"])("rejects unsupported month %s across decisions and queries", (month) => {
    expect(consumptionDecisionSchema.safeParse(decision({ month })).success).toBe(false);
    expect(usageQuerySchema.safeParse({ month }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ month }).success).toBe(false);
  });

  it("accepts a complete accepted decision", () => {
    expect(consumptionDecisionSchema.safeParse(decision()).success).toBe(true);
  });

  it("accepts a quota rejection with its blocking rule and scope", () => {
    const rejected = decision({
      accepted: false,
      account: {
        consumed: 9_995,
        remaining: 5,
        plan: { id: 1, revision: 2 }
      },
      user: {
        consumed: 20,
        remaining: 980,
        plan: { id: 3, revision: 1 }
      },
      blockedBy: {
        scope: "account",
        rule: "monthly_limit",
        limit: 10_000
      }
    });

    expect(consumptionDecisionSchema.safeParse(rejected).success).toBe(true);
  });

  it("rejects inconsistent, incomplete, and numerically unsafe responses", () => {
    expect(
      consumptionDecisionSchema.safeParse({
        ...decision(),
        accepted: false,
        blockedBy: null
      }).success
    ).toBe(false);
    expect(
      consumptionDecisionSchema.safeParse({
        ...decision(),
        account: { consumed: -1, remaining: 10 }
      }).success
    ).toBe(false);
    expect(
      consumptionDecisionSchema.safeParse({
        ...decision(),
        month: "2026-13"
      }).success
    ).toBe(false);
  });
});

describe("POST /consume contract boundary", () => {
  it.each([0, -1, 1.5, "5", null, MAX_QUANTITY + 1])(
    "rejects units=%s before accounting",
    async (units) => {
      const response = await createTestApp().inject({
        method: "POST",
        url: "/consume",
        headers: { "x-api-key": validApiKey },
        payload: { userId: ownedUserId, units, requestId: "consume-1" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_REQUEST" }
      });
      expect(connectSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    { userId: "", units: 1, requestId: "consume-1" },
    { units: 1, requestId: "consume-1" },
    { userId: ownedUserId, units: 1, requestId: "" },
    { userId: ownedUserId, units: 1 },
    { userId: ownedUserId, requestId: "consume-1" },
    { userId: ownedUserId, units: 1, requestId: "a".repeat(129) },
    { userId: ownedUserId, units: 1, requestId: "consume-1", accountId }
  ])("rejects an invalid identity body before accounting: %#", async (payload) => {
    const response = await createTestApp().inject({
      method: "POST",
      url: "/consume",
      headers: { "x-api-key": validApiKey },
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" }
    });
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("authenticates before validation or accounting", async () => {
    let consumeCalls = 0;
    const response = await createTestApp(async () => {
      consumeCalls += 1;
      return decision();
    }).inject({
      method: "POST",
      url: "/consume",
      payload: {
        userId: ownedUserId,
        units: 1,
        requestId: "consume-1"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
    expect(consumeCalls).toBe(0);
  });

  it.each([1, MAX_QUANTITY])(
    "passes valid units=%s and the authenticated account to accounting",
    async (units) => {
      const calls: Array<{ accountId: string; input: unknown }> = [];
      const response = await createTestApp(async (authenticatedId, input) => {
        calls.push({ accountId: authenticatedId, input });
        return decision({ units });
      }).inject({
        method: "POST",
        url: "/consume",
        headers: { "x-api-key": validApiKey },
        payload: {
          userId: ownedUserId,
          units,
          requestId: "consume-1"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(calls).toEqual([
        {
          accountId,
          input: {
            userId: ownedUserId,
            units,
            requestId: "consume-1"
          }
        }
      ]);
    }
  );

  it("returns a recorded quota rejection as a successful HTTP decision", async () => {
    const recorded: ConsumptionDecision[] = [];
    const rejected = decision({
      accepted: false,
      blockedBy: {
        scope: "user",
        rule: "max_units_per_request",
        limit: 5
      }
    });
    const response = await createTestApp(async () => {
      recorded.push(rejected);
      return rejected;
    }).inject({
      method: "POST",
      url: "/consume",
      headers: { "x-api-key": validApiKey },
      payload: {
        userId: ownedUserId,
        units: 4,
        requestId: "consume-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: false,
      blockedBy: {
        scope: "user",
        rule: "max_units_per_request",
        limit: 5
      }
    });
    expect(recorded).toHaveLength(1);
  });

  it.each([foreignUserId, unknownUserId])(
    "hides an unavailable user behind USER_NOT_FOUND",
    async (userId) => {
      const response = await createTestApp(async () => null).inject({
        method: "POST",
        url: "/consume",
        headers: { "x-api-key": validApiKey },
        payload: { userId, units: 1, requestId: "consume-1" }
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "USER_NOT_FOUND" }
      });
    }
  );

  it("preserves the request-ID conflict status", async () => {
    const response = await createTestApp(async () => {
      throw new RequestIdConflictError();
    }).inject({
      method: "POST",
      url: "/consume",
      headers: { "x-api-key": validApiKey },
      payload: {
        userId: ownedUserId,
        units: 1,
        requestId: "consume-1"
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "REQUEST_ID_CONFLICT" }
    });
  });
});
