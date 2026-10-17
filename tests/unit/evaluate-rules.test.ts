import { describe, expect, it } from "vitest";

import {
  evaluateRules,
  type EvaluateRulesInput,
  type QuotaState
} from "../../src/modules/usage/evaluate-rules.js";
import { MAX_QUANTITY } from "../../src/shared/validation.js";

function input(
  units: number,
  account: Partial<QuotaState> = {},
  user: Partial<QuotaState> = {}
): EvaluateRulesInput {
  return {
    units,
    account: {
      monthlyLimit: 10_000,
      maxUnitsPerRequest: 100,
      consumed: 0,
      ...account
    },
    user: {
      monthlyLimit: 1_000,
      maxUnitsPerRequest: 20,
      consumed: 0,
      ...user
    }
  };
}

describe("evaluateRules acceptance", () => {
  it.each([
    {
      name: "the brief's 10-unit example",
      request: input(10),
      account: { consumed: 10, remaining: 9_990 },
      user: { consumed: 10, remaining: 990 }
    },
    {
      name: "exact equality with both per-request caps",
      request: input(20, { maxUnitsPerRequest: 20 }),
      account: { consumed: 20, remaining: 9_980 },
      user: { consumed: 20, remaining: 980 }
    },
    {
      name: "exactly five units left at both scopes",
      request: input(5, { consumed: 9_995 }, { consumed: 995 }),
      account: { consumed: 10_000, remaining: 0 },
      user: { consumed: 1_000, remaining: 0 }
    },
    {
      name: "the largest permitted request and totals",
      request: input(
        MAX_QUANTITY,
        { monthlyLimit: MAX_QUANTITY, maxUnitsPerRequest: MAX_QUANTITY },
        { monthlyLimit: MAX_QUANTITY, maxUnitsPerRequest: MAX_QUANTITY }
      ),
      account: { consumed: MAX_QUANTITY, remaining: 0 },
      user: { consumed: MAX_QUANTITY, remaining: 0 }
    },
    {
      name: "the last unit before the numeric bound",
      request: input(
        1,
        { monthlyLimit: MAX_QUANTITY, consumed: 2_147_483_646 },
        { monthlyLimit: MAX_QUANTITY, consumed: 2_147_483_646 }
      ),
      account: { consumed: MAX_QUANTITY, remaining: 0 },
      user: { consumed: MAX_QUANTITY, remaining: 0 }
    }
  ])("accepts $name", ({ request, account, user }) => {
    expect(evaluateRules(request)).toEqual({
      accepted: true,
      blockedBy: null,
      account,
      user
    });
  });
});

describe("evaluateRules isolated blockers", () => {
  it.each([
    {
      name: "account request cap",
      request: input(11, { maxUnitsPerRequest: 10 }),
      blockedBy: { scope: "account", rule: "max_units_per_request", limit: 10 },
      account: { consumed: 0, remaining: 10_000 },
      user: { consumed: 0, remaining: 1_000 }
    },
    {
      name: "user request cap",
      request: input(25),
      blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 },
      account: { consumed: 0, remaining: 10_000 },
      user: { consumed: 0, remaining: 1_000 }
    },
    {
      name: "account monthly allowance",
      request: input(6, { monthlyLimit: 100, consumed: 95 }),
      blockedBy: { scope: "account", rule: "monthly_limit", limit: 100 },
      account: { consumed: 95, remaining: 5 },
      user: { consumed: 0, remaining: 1_000 }
    },
    {
      name: "user monthly allowance",
      request: input(6, {}, { monthlyLimit: 100, consumed: 95 }),
      blockedBy: { scope: "user", rule: "monthly_limit", limit: 100 },
      account: { consumed: 0, remaining: 10_000 },
      user: { consumed: 95, remaining: 5 }
    },
    {
      name: "six units when both scopes have only five left",
      request: input(6, { consumed: 9_995 }, { consumed: 995 }),
      blockedBy: { scope: "account", rule: "monthly_limit", limit: 10_000 },
      account: { consumed: 9_995, remaining: 5 },
      user: { consumed: 995, remaining: 5 }
    }
  ])(
    "rejects $name without changing either total",
    ({ request, blockedBy, account, user }) => {
      expect(evaluateRules(request)).toEqual({
        accepted: false,
        blockedBy,
        account,
        user
      });
    }
  );

  it.each(["account", "user"] as const)(
    "rejects a %s total that would exceed the numeric bound",
    (scope) => {
      const request = input(2);
      const result = evaluateRules({
        ...request,
        [scope]: {
          ...request[scope],
          monthlyLimit: MAX_QUANTITY,
          consumed: 2_147_483_646
        }
      });

      expect(result.accepted).toBe(false);
      expect(result.blockedBy).toEqual({
        scope,
        rule: "monthly_limit",
        limit: MAX_QUANTITY
      });
      expect(result[scope]).toEqual({ consumed: 2_147_483_646, remaining: 1 });
    }
  );
});

describe("zero limits and plan downgrades", () => {
  it.each([
    { scope: "account", field: "maxUnitsPerRequest", rule: "max_units_per_request" },
    { scope: "user", field: "maxUnitsPerRequest", rule: "max_units_per_request" },
    { scope: "account", field: "monthlyLimit", rule: "monthly_limit" },
    { scope: "user", field: "monthlyLimit", rule: "monthly_limit" }
  ] as const)("denies a zero $scope $field", ({ scope, field, rule }) => {
    const request = input(1);
    const result = evaluateRules({
      ...request,
      [scope]: { ...request[scope], [field]: 0 }
    });

    expect(result.accepted).toBe(false);
    expect(result.blockedBy).toEqual({ scope, rule, limit: 0 });
    expect(result.account.consumed).toBe(0);
    expect(result.user.consumed).toBe(0);
    if (field === "monthlyLimit") {
      expect(result[scope].remaining).toBe(0);
    }
  });

  it.each(["account", "user"] as const)(
    "preserves %s usage above a lowered monthly limit",
    (scope) => {
      const request = input(1);
      const result = evaluateRules({
        ...request,
        [scope]: { ...request[scope], monthlyLimit: 10, consumed: 12 }
      });

      expect(result.accepted).toBe(false);
      expect(result.blockedBy).toEqual({ scope, rule: "monthly_limit", limit: 10 });
      expect(result[scope]).toEqual({ consumed: 12, remaining: 0 });
      const otherScope = scope === "account" ? "user" : "account";
      expect(result[otherScope].consumed).toBe(0);
    }
  );
});

describe("first-blocker precedence", () => {
  it.each([
    {
      name: "account request cap before all three other blockers",
      request: input(
        25,
        { monthlyLimit: 0, maxUnitsPerRequest: 10 },
        { monthlyLimit: 0 }
      ),
      blockedBy: { scope: "account", rule: "max_units_per_request", limit: 10 }
    },
    {
      name: "user request cap before both monthly blockers",
      request: input(25, { monthlyLimit: 0 }, { monthlyLimit: 0 }),
      blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 }
    },
    {
      name: "account monthly allowance before user monthly allowance",
      request: input(1, { monthlyLimit: 0 }, { monthlyLimit: 0 }),
      blockedBy: { scope: "account", rule: "monthly_limit", limit: 0 }
    }
  ])("chooses $name", ({ request, blockedBy }) => {
    expect(evaluateRules(request).blockedBy).toEqual(blockedBy);
  });
});

describe("pure evaluation", () => {
  it.each([
    { name: "acceptance", request: input(10) },
    { name: "rejection", request: input(25) }
  ])("does not mutate input on $name and repeats the same result", ({ request }) => {
    const original = structuredClone(request);
    Object.freeze(request.account);
    Object.freeze(request.user);
    Object.freeze(request);

    const first = evaluateRules(request);
    const second = evaluateRules(request);

    expect(request).toEqual(original);
    expect(second).toEqual(first);
    expect(first.account).not.toBe(request.account);
    expect(first.user).not.toBe(request.user);
    expect(second.account).not.toBe(first.account);
    expect(second.user).not.toBe(first.user);
  });
});
