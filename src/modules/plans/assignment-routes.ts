import type { FastifyInstance } from "fastify";

import { authenticatedAccountId } from "../../middleware/authenticate-api-key.js";
import { AppError } from "../../shared/errors.js";
import {
  parseRequestBody,
  planAssignmentBodySchema,
  userIdSchema
} from "../../shared/validation.js";
import type { User } from "../users/service.js";
import {
  AssignmentUserNotFoundError,
  PlanAssignmentError,
  type AssignedAccount
} from "./assignment.js";

export interface AssignmentRouteOperations {
  assignAccountPlan(accountId: string, planId: number): Promise<AssignedAccount>;
  assignUserPlan(
    accountId: string,
    userId: string,
    planId: number
  ): Promise<User>;
}

function mapPlanAssignmentError(error: PlanAssignmentError): AppError {
  if (error.code === "PLAN_SCOPE_MISMATCH") {
    return new AppError(
      "The selected plan has the wrong assignment scope.",
      422,
      "PLAN_SCOPE_MISMATCH"
    );
  }

  return new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
}

export function registerAssignmentRoutes(
  app: FastifyInstance,
  operations: AssignmentRouteOperations
): void {
  app.patch("/account/plan", async (request) => {
    const accountId = authenticatedAccountId(request);
    const input = parseRequestBody(planAssignmentBodySchema, request.body);

    try {
      const account = await operations.assignAccountPlan(accountId, input.planId);
      return { account };
    } catch (error) {
      if (error instanceof PlanAssignmentError) {
        throw mapPlanAssignmentError(error);
      }

      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/users/:id/plan",
    async (request) => {
      const accountId = authenticatedAccountId(request);

      if (!userIdSchema.safeParse(request.params.id).success) {
        throw new AppError("User not found.", 404, "USER_NOT_FOUND");
      }

      const input = parseRequestBody(planAssignmentBodySchema, request.body);

      try {
        const user = await operations.assignUserPlan(
          accountId,
          request.params.id,
          input.planId
        );
        return { user };
      } catch (error) {
        if (error instanceof AssignmentUserNotFoundError) {
          throw new AppError("User not found.", 404, "USER_NOT_FOUND");
        }

        if (error instanceof PlanAssignmentError) {
          throw mapPlanAssignmentError(error);
        }

        throw error;
      }
    }
  );
}
