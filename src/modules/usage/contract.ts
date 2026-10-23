import { z } from "zod";

import {
  consumeBodySchema,
  planIdSchema,
  planLimitSchema,
  requestIdSchema,
  unitsSchema,
  usageMonthSchema,
  userIdSchema
} from "../../shared/validation.js";

export const quotaScopeSchema = z.enum(["account", "user"]);

export const quotaRuleSchema = z.enum([
  "max_units_per_request",
  "monthly_limit"
]);

const appliedPlanSchema = z.strictObject({
  id: planIdSchema,
  revision: z.number().int().min(1)
});

const decisionBalanceSchema = z.strictObject({
  consumed: planLimitSchema,
  remaining: planLimitSchema,
  plan: appliedPlanSchema
});

const decisionBaseSchema = z.strictObject({
  requestId: requestIdSchema,
  userId: userIdSchema,
  units: unitsSchema,
  processedAt: z.iso.datetime({ offset: true }),
  month: usageMonthSchema,
  account: decisionBalanceSchema,
  user: decisionBalanceSchema
});

const blockingRuleSchema = z.strictObject({
  scope: quotaScopeSchema,
  rule: quotaRuleSchema,
  limit: planLimitSchema
});

export const acceptedConsumptionSchema = decisionBaseSchema.extend({
  accepted: z.literal(true),
  blockedBy: z.null()
});

export const rejectedConsumptionSchema = decisionBaseSchema.extend({
  accepted: z.literal(false),
  blockedBy: blockingRuleSchema
});

export const consumptionDecisionSchema = z.discriminatedUnion("accepted", [
  acceptedConsumptionSchema,
  rejectedConsumptionSchema
]);

export type ConsumeRequest = z.infer<typeof consumeBodySchema>;
export type UsageMonth = z.infer<typeof usageMonthSchema>;
export type QuotaScope = z.infer<typeof quotaScopeSchema>;
export type QuotaRule = z.infer<typeof quotaRuleSchema>;
export type ConsumptionDecision = z.infer<typeof consumptionDecisionSchema>;

export function parseConsumptionDecision(value: unknown): ConsumptionDecision {
  return consumptionDecisionSchema.parse(value);
}
