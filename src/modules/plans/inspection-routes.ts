import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError, InvalidRequestError } from "../../shared/errors.js";
import { currentRulesQuerySchema, userIdSchema } from "../../shared/validation.js";
import type { AccountRules, UserRules } from "../usage/queries.js";

export interface RuleRouteOperations {
  readAccountRules(accountId: string): Promise<AccountRules | null>;
  readUserRules(accountId: string, userId: string): Promise<UserRules | null>;
}

function authenticatedAccountId(request: FastifyRequest): string {
  if (request.authenticatedAccount === null) {
    throw new Error("Authenticated account context is missing.");
  }
  if (!currentRulesQuerySchema.safeParse(request.query).success) {
    throw new InvalidRequestError("Current rule inspection does not accept query parameters.");
  }
  return request.authenticatedAccount.id;
}

export function registerRuleRoutes(app: FastifyInstance, operations: RuleRouteOperations): void {
  app.get("/account/rules", async (request) => {
    const rules = await operations.readAccountRules(authenticatedAccountId(request));
    if (rules === null) throw new AppError("Account not found.", 404, "NOT_FOUND");
    return rules;
  });

  app.get<{ Params: { id: string } }>("/users/:id/rules", async (request) => {
    const accountId = authenticatedAccountId(request);
    if (!userIdSchema.safeParse(request.params.id).success) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }
    const rules = await operations.readUserRules(accountId, request.params.id);
    if (rules === null) throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    return rules;
  });
}
