import { describe, expect, it } from "vitest";

import {
  consumptionSnapshotSchema,
  parseConsumptionSnapshot,
  type ConsumptionSnapshot
} from "../../src/modules/usage/snapshot.js";
import { MAX_QUANTITY } from "../../src/shared/validation.js";

function snapshot(): ConsumptionSnapshot {
  return {
    response: {
      requestId: "snapshot-example",
      userId: "00000000-0000-4000-8000-000000000020",
      units: 4,
      accepted: true,
      blockedBy: null,
      processedAt: "2026-10-17T12:30:00.000Z",
      month: "2026-10",
      account: { consumed: 4, remaining: 96, plan: { id: 1, revision: 1 } },
      user: { consumed: 4, remaining: 6, plan: { id: 3, revision: 1 } }
    },
    evaluatedLimits: {
      account: { monthlyLimit: 100, maxUnitsPerRequest: 20 },
      user: { monthlyLimit: 10, maxUnitsPerRequest: 5 }
    }
  };
}

describe("stored consumption snapshots", () => {
  it("preserves the complete response and both sets of rule values through JSON storage", () => {
    const original = snapshot();
    expect(parseConsumptionSnapshot(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it("preserves a rejected response and the original blocking cap", () => {
    const original = snapshot();
    original.response = {
      ...original.response,
      units: 6,
      accepted: false,
      blockedBy: { scope: "user", rule: "max_units_per_request", limit: 5 },
      account: { consumed: 0, remaining: 100, plan: { id: 1, revision: 1 } },
      user: { consumed: 0, remaining: 10, plan: { id: 3, revision: 1 } }
    };
    expect(parseConsumptionSnapshot(original)).toEqual(original);
  });

  it.each([
    { account: { monthlyLimit: 100, maxUnitsPerRequest: 20 } },
    { user: { monthlyLimit: 10, maxUnitsPerRequest: 5 } },
    { account: { monthlyLimit: 100 }, user: { monthlyLimit: 10, maxUnitsPerRequest: 5 } },
    { account: { monthlyLimit: -1, maxUnitsPerRequest: 20 }, user: { monthlyLimit: 10, maxUnitsPerRequest: 5 } },
    { account: { monthlyLimit: 100, maxUnitsPerRequest: MAX_QUANTITY + 1 }, user: { monthlyLimit: 10, maxUnitsPerRequest: 5 } }
  ])("rejects missing or invalid evaluated limits: %#", (evaluatedLimits) => {
    expect(consumptionSnapshotSchema.safeParse({ ...snapshot(), evaluatedLimits }).success).toBe(false);
  });

  it("rejects unsupported snapshot fields instead of dropping stored evidence", () => {
    expect(consumptionSnapshotSchema.safeParse({ ...snapshot(), accountId: "unexpected" }).success).toBe(false);
  });
});
