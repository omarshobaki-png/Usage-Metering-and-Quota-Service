import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError, InvalidRequestError } from "../../shared/errors.js";
import { usageQuerySchema, userIdSchema } from "../../shared/validation.js";
import type { AccountUsage, UserUsage } from "./queries.js";

export interface UsageRouteOperations {
  readAccountUsage(accountId: string, month?: string): Promise<AccountUsage | null>;
  readUserUsage(accountId: string, userId: string, month?: string): Promise<UserUsage | null>;
}

function authenticatedAccountId(request: FastifyRequest): string {
  if (request.authenticatedAccount === null) {
    throw new Error("Authenticated account context is missing.");
  }
  return request.authenticatedAccount.id;
}

function selectedMonth(query: unknown): string | undefined {
  const result = usageQuerySchema.safeParse(query);
  if (!result.success) throw new InvalidRequestError("Query parameters are invalid.");
  return result.data.month;
}

export function registerUsageRoutes(app: FastifyInstance, operations: UsageRouteOperations): void {
  app.get("/usage", async (request) => {
    const accountId = authenticatedAccountId(request);
    const usage = await operations.readAccountUsage(accountId, selectedMonth(request.query));
    if (usage === null) throw new AppError("Account not found.", 404, "NOT_FOUND");
    return usage;
  });

  app.get<{ Params: { id: string } }>("/users/:id/usage", async (request) => {
    const accountId = authenticatedAccountId(request);
    const month = selectedMonth(request.query);
    if (!userIdSchema.safeParse(request.params.id).success) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }
    const usage = await operations.readUserUsage(accountId, request.params.id, month);
    if (usage === null) throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    return usage;
  });
}
