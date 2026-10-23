import type { FastifyInstance } from "fastify";

import { authenticatedAccountId } from "../../middleware/authenticate-api-key.js";
import { AppError } from "../../shared/errors.js";
import type { ConsumptionDecision } from "./contract.js";

export interface ConsumptionRouteOperations {
  consume(
    accountId: string,
    input: unknown
  ): Promise<ConsumptionDecision | null>;
}

export function registerConsumptionRoutes(
  app: FastifyInstance,
  operations: ConsumptionRouteOperations
): void {
  app.post("/consume", async (request, reply) => {
    const accountId = authenticatedAccountId(request);
    const result = await operations.consume(accountId, request.body);

    if (result === null) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }

    return reply.status(200).send(result);
  });
}
