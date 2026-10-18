import { z } from "zod";

import { InvalidRequestError } from "./errors.js";

export const MAX_QUANTITY = 2_147_483_647;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_PLAN_NAME_LENGTH = 100;

const wholeNumberSchema = z.number().int();

export const userIdSchema = z.string().uuid();

export const planIdSchema = wholeNumberSchema.min(1).max(MAX_QUANTITY);

export const unitsSchema = wholeNumberSchema.min(1).max(MAX_QUANTITY);

// Preserve the original descriptive export for quantity-only callers.
export const positiveUnitsSchema = unitsSchema;

export const planLimitSchema = wholeNumberSchema.min(0).max(MAX_QUANTITY);

export const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/);

export const planNameSchema = z.string().trim().min(1).max(MAX_PLAN_NAME_LENGTH);

export const planScopeSchema = z.enum(["account", "user"]);

export const planListQuerySchema = z.strictObject({
  scope: planScopeSchema.optional()
});

export const usageMonthSchema = z.string().length(7).regex(/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/);

export const usageQuerySchema = z.strictObject({
  month: usageMonthSchema.optional()
});

export const currentRulesQuerySchema = z.strictObject({});

export const historyQuerySchema = z.strictObject({
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number).default(20),
  userId: userIdSchema.optional(),
  month: usageMonthSchema.optional(),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional()
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const createUserBodySchema = z.strictObject({
  planId: planIdSchema.optional()
});

export const createCustomPlanBodySchema = z.strictObject({
  name: planNameSchema,
  scope: planScopeSchema,
  monthlyLimit: planLimitSchema,
  requestLimit: planLimitSchema
});

export const updateCustomPlanBodySchema = z
  .strictObject({
    name: planNameSchema.optional(),
    monthlyLimit: planLimitSchema.optional(),
    requestLimit: planLimitSchema.optional()
  })
  .refine((body) => Object.keys(body).length > 0);

export const planAssignmentBodySchema = z.strictObject({
  planId: planIdSchema
});

export const consumeBodySchema = z.strictObject({
  userId: userIdSchema,
  units: unitsSchema,
  requestId: requestIdSchema
});

export type CreateUserBody = z.infer<typeof createUserBodySchema>;
export type PlanScope = z.infer<typeof planScopeSchema>;
export type PlanListQuery = z.infer<typeof planListQuerySchema>;
export type CreateCustomPlanBody = z.infer<typeof createCustomPlanBodySchema>;
export type UpdateCustomPlanBody = z.infer<typeof updateCustomPlanBodySchema>;
export type PlanAssignmentBody = z.infer<typeof planAssignmentBodySchema>;
export type ConsumeBody = z.infer<typeof consumeBodySchema>;

export function parseRequestBody<T>(
  schema: z.ZodType<T>,
  body: unknown
): T {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new InvalidRequestError();
  }

  return result.data;
}
