import type { FastifyInstance } from "fastify";

import { InvalidRequestError } from "../../shared/errors.js";
import { historyQuerySchema, type HistoryQuery } from "../../shared/validation.js";
import type { HistoryPage } from "./history.js";

export interface HistoryRouteOperations {
  readHistory(accountId: string, query: HistoryQuery): Promise<HistoryPage>;
}

export function registerHistoryRoutes(app: FastifyInstance, operations: HistoryRouteOperations): void {
  app.get("/history", async (request) => {
    const account = request.authenticatedAccount;
    if (account === null) throw new Error("Authenticated account context is missing.");
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new InvalidRequestError("History query is invalid. Use limit 1–100, optional userId/month, and a valid cursor.");
    }
    return operations.readHistory(account.id, query.data);
  });
}
