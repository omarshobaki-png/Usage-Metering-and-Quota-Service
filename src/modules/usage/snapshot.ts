import { z } from "zod";

import { planLimitSchema } from "../../shared/validation.js";
import { consumptionDecisionSchema } from "./contract.js";

const evaluatedLimitsSchema = z.strictObject({
  monthlyLimit: planLimitSchema,
  maxUnitsPerRequest: planLimitSchema
});

// This is stored evidence, not a lookup into the current mutable plan rows.
export const consumptionSnapshotSchema = z.strictObject({
  response: consumptionDecisionSchema,
  evaluatedLimits: z.strictObject({
    account: evaluatedLimitsSchema,
    user: evaluatedLimitsSchema
  })
});

export type ConsumptionSnapshot = z.infer<typeof consumptionSnapshotSchema>;

export function parseConsumptionSnapshot(value: unknown): ConsumptionSnapshot {
  return consumptionSnapshotSchema.parse(value);
}
