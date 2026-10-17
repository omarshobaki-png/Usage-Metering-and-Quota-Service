import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "../../shared/errors.js";
import {
  createUserBodySchema,
  parseRequestBody,
  userIdSchema
} from "../../shared/validation.js";
import { PlanAssignmentError } from "../plans/assignment.js";
import type { CreateUserInput, User } from "./service.js";

export interface UserRouteOperations {
  createUser(accountId: string, input: CreateUserInput): Promise<User>;
  getUser(accountId: string, userId: string): Promise<User | null>;
}

function authenticatedAccountId(request: FastifyRequest): string {
  const account = request.authenticatedAccount;

  if (account === null) {
    throw new Error("Authenticated account context is missing.");
  }

  return account.id;
}

function parseCreateUserInput(body: unknown): CreateUserInput {
  const input = parseRequestBody(
    createUserBodySchema,
    body === undefined ? {} : body
  );

  return input.planId === undefined ? {} : { planId: input.planId };
}

function planAssignmentHttpError(error: PlanAssignmentError): AppError {
  if (error.code === "PLAN_SCOPE_MISMATCH") {
    return new AppError(
      "The selected plan cannot be assigned to a user.",
      422,
      "PLAN_SCOPE_MISMATCH"
    );
  }

  return new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
}

export function registerUserRoutes(
  app: FastifyInstance,
  operations: UserRouteOperations
): void {
  app.post("/users", async (request, reply) => {
    const accountId = authenticatedAccountId(request);
    const input = parseCreateUserInput(request.body);

    try {
      const user = await operations.createUser(accountId, input);
      return reply.status(201).send({ user });
    } catch (error) {
      if (error instanceof PlanAssignmentError) {
        throw planAssignmentHttpError(error);
      }

      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/users/:id", async (request) => {
    const accountId = authenticatedAccountId(request);

    if (!userIdSchema.safeParse(request.params.id).success) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }

    const user = await operations.getUser(accountId, request.params.id);

    if (user === null) {
      throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    }

    return { user };
  });
}
