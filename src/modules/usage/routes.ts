import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "../../shared/errors.js";
import {
  consumeBodySchema,
  parseRequestBody
} from "../../shared/validation.js";
import {
  parseConsumptionDecision,
  type ConsumeRequest,
  type ConsumptionDecision
} from "./contract.js";

export interface ConsumptionRouteOperations {
  consume(
    accountId: string,
    input: ConsumeRequest
  ): Promise<ConsumptionDecision | null>;
}

function authenticatedAccountId(request: FastifyRequest): string {
  const account = request.authenticatedAccount;

  if (account === null) {
    throw new Error("Authenticated account context is missing.");
  }

  return account.id;
}

export function registerConsumptionRoutes(
  app: FastifyInstance,
  operations: ConsumptionRouteOperations
): void {
  app.post("/consume", async (request, reply) => {
    const accountId = authenticatedAccountId(request);
    const input = parseRequestBody(consumeBodySchema, request.body);
    const result = await operations.consume(accountId, input);

    if (result === null) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }

    const decision = parseConsumptionDecision(result);
    return reply.status(200).send(decision);
  });
}
