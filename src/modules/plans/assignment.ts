import type { PoolClient } from "pg";

export type AssignmentScope = "account" | "user";

export interface AssignablePlan {
  id: number;
  name: string;
  scope: AssignmentScope;
  ownerAccountId: string | null;
  monthlyLimit: number;
  maxUnitsPerRequest: number;
  revision: number;
}

export type PlanAssignmentErrorCode =
  | "PLAN_NOT_FOUND"
  | "PLAN_SCOPE_MISMATCH"
  | "PLAN_NOT_AVAILABLE";

export class PlanAssignmentError extends Error {
  public constructor(
    public readonly code: PlanAssignmentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PlanAssignmentError";
  }
}

interface ValidatePlanAssignmentInput {
  accountId: string;
  planId: number | undefined;
  requiredScope: AssignmentScope;
  defaultPredefinedPlanName: string;
}

export async function validatePlanAssignment(
  client: PoolClient,
  input: ValidatePlanAssignmentInput
): Promise<AssignablePlan> {
  const planResult =
    input.planId === undefined
      ? await client.query<AssignablePlan>(
          `
            SELECT
              id,
              name,
              scope,
              owner_account_id AS "ownerAccountId",
              monthly_limit AS "monthlyLimit",
              max_units_per_request AS "maxUnitsPerRequest",
              revision
            FROM plans
            WHERE owner_account_id IS NULL AND name = $1
            ORDER BY id
            LIMIT 1
          `,
          [input.defaultPredefinedPlanName]
        )
      : await client.query<AssignablePlan>(
          `
            SELECT
              id,
              name,
              scope,
              owner_account_id AS "ownerAccountId",
              monthly_limit AS "monthlyLimit",
              max_units_per_request AS "maxUnitsPerRequest",
              revision
            FROM plans
            WHERE id = $1
          `,
          [input.planId]
        );
  const plan = planResult.rows[0];

  if (plan === undefined) {
    const description =
      input.planId ?? `predefined plan ${input.defaultPredefinedPlanName}`;
    throw new PlanAssignmentError(
      "PLAN_NOT_FOUND",
      `Plan "${description}" does not exist.`
    );
  }

  if (plan.scope !== input.requiredScope) {
    throw new PlanAssignmentError(
      "PLAN_SCOPE_MISMATCH",
      `Plan "${plan.id}" has ${plan.scope} scope; ${input.requiredScope} scope is required.`
    );
  }

  if (
    plan.ownerAccountId !== null &&
    plan.ownerAccountId !== input.accountId
  ) {
    throw new PlanAssignmentError(
      "PLAN_NOT_AVAILABLE",
      `Plan "${plan.id}" is not available to account "${input.accountId}".`
    );
  }

  return plan;
}
