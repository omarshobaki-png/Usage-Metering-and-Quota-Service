import type { FastifyInstance } from "fastify";

import { authenticatedAccountId } from "../../middleware/authenticate-api-key.js";
import { AppError, InvalidRequestError } from "../../shared/errors.js";
import { currentRulesQuerySchema, userIdSchema } from "../../shared/validation.js";
import type { AccountRules, UserRules } from "../usage/queries.js";

export interface RuleRouteOperations {
  readAccountRules(accountId: string): Promise<AccountRules | null>;
  readUserRules(accountId: string, userId: string): Promise<UserRules | null>;
}

function validateCurrentRulesQuery(query: unknown): void {
  if (!currentRulesQuerySchema.safeParse(query).success) {
    throw new InvalidRequestError("Current rule inspection does not accept query parameters.");
  }
}

export function registerRuleRoutes(app: FastifyInstance, operations: RuleRouteOperations): void {
  app.get("/account/rules", async (request) => {
    const accountId = authenticatedAccountId(request);
    validateCurrentRulesQuery(request.query);
    const rules = await operations.readAccountRules(accountId);
    if (rules === null) throw new AppError("Account not found.", 404, "NOT_FOUND");
    return rules;
  });

  app.get<{ Params: { id: string } }>("/users/:id/rules", async (request) => {
    const accountId = authenticatedAccountId(request);
    validateCurrentRulesQuery(request.query);
    if (!userIdSchema.safeParse(request.params.id).success) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }
    const rules = await operations.readUserRules(accountId, request.params.id);
    if (rules === null) throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    return rules;
  });
}
