import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  AppError,
  InvalidRequestError,
  PredefinedPlanReadOnlyError
} from "../../shared/errors.js";
import {
  createCustomPlanBodySchema,
  parseRequestBody,
  planIdSchema,
  planListQuerySchema,
  updateCustomPlanBodySchema,
  type CreateCustomPlanBody,
  type PlanListQuery,
  type PlanScope,
  type UpdateCustomPlanBody
} from "../../shared/validation.js";
import {
  PlanMutationError,
  type Plan
} from "./service.js";

export interface PlanRouteOperations {
  createCustomPlan(accountId: string, input: CreateCustomPlanBody): Promise<Plan>;
  listPlans(accountId: string, scope?: PlanScope): Promise<Plan[]>;
  getPlan(accountId: string, planId: number): Promise<Plan | null>;
  updateCustomPlan(
    accountId: string,
    planId: number,
    input: UpdateCustomPlanBody
  ): Promise<Plan>;
}

function authenticatedAccountId(request: FastifyRequest): string {
  const account = request.authenticatedAccount;

  if (account === null) {
    throw new Error("Authenticated account context is missing.");
  }

  return account.id;
}

function parsePlanId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
  }

  const planId = Number(value);

  if (!planIdSchema.safeParse(planId).success) {
    throw new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
  }

  return planId;
}

function parsePlanListQuery(query: unknown): PlanListQuery {
  const result = planListQuerySchema.safeParse(query);

  if (!result.success) {
    throw new InvalidRequestError("Query parameters are invalid.");
  }

  return result.data;
}

function mapPlanMutationError(error: PlanMutationError): AppError {
  if (error.code === "PREDEFINED_PLAN_READ_ONLY") {
    return new PredefinedPlanReadOnlyError();
  }

  return new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
}

export function registerPlanRoutes(
  app: FastifyInstance,
  operations: PlanRouteOperations
): void {
  app.post("/plans", async (request, reply) => {
    const accountId = authenticatedAccountId(request);
    const input = parseRequestBody(createCustomPlanBodySchema, request.body);
    const plan = await operations.createCustomPlan(accountId, input);

    return reply.status(201).send({ plan });
  });

  app.get<{ Querystring: PlanListQuery }>("/plans", async (request) => {
    const accountId = authenticatedAccountId(request);
    const query = parsePlanListQuery(request.query);
    const plans = await operations.listPlans(accountId, query.scope);

    return { plans };
  });

  app.get<{ Params: { id: string } }>("/plans/:id", async (request) => {
    const accountId = authenticatedAccountId(request);
    const planId = parsePlanId(request.params.id);
    const plan = await operations.getPlan(accountId, planId);

    if (plan === null) {
      throw new AppError("Plan not found.", 404, "PLAN_NOT_FOUND");
    }

    return { plan };
  });

  app.patch<{ Params: { id: string } }>(
    "/plans/:id",
    async (request) => {
      const accountId = authenticatedAccountId(request);
      const planId = parsePlanId(request.params.id);
      const input = parseRequestBody(updateCustomPlanBodySchema, request.body);

      try {
        const plan = await operations.updateCustomPlan(accountId, planId, input);
        return { plan };
      } catch (error) {
        if (error instanceof PlanMutationError) {
          throw mapPlanMutationError(error);
        }

        throw error;
      }
    }
  );
}
