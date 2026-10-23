import type { Pool, PoolClient } from "pg";

import { withLockedAccountTransaction } from "../../db/account-transaction.js";
import type { User } from "../users/service.js";
import type { PlanSummary } from "./types.js";

export type AssignmentScope = "account" | "user";

export interface AssignablePlan extends PlanSummary {
  ownerAccountId: string | null;
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

export class AssignmentUserNotFoundError extends Error {
  public constructor() {
    super("User not found.");
    this.name = "AssignmentUserNotFoundError";
  }
}

export interface AssignedAccount {
  id: string;
  name: string;
  plan: PlanSummary;
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
              AND (owner_account_id IS NULL OR owner_account_id = $2)
          `,
          [input.planId, input.accountId]
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

function planSummary(plan: AssignablePlan): PlanSummary {
  return {
    id: plan.id,
    name: plan.name,
    scope: plan.scope,
    monthlyLimit: plan.monthlyLimit,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
    revision: plan.revision
  };
}

export async function assignAccountPlan(
  pool: Pool,
  accountId: string,
  planId: number
): Promise<AssignedAccount> {
  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const plan = await validatePlanAssignment(client, {
      accountId,
      planId,
      requiredScope: "account",
      defaultPredefinedPlanName: "Starter"
    });
    const accountResult = await client.query<{ id: string; name: string }>(
      `
        UPDATE accounts
        SET account_plan_id = $2
        WHERE id = $1
        RETURNING id, name
      `,
      [accountId, plan.id]
    );
    const account = accountResult.rows[0];

    if (account === undefined) {
      throw new Error("The account was not returned after plan assignment.");
    }

    return {
      ...account,
      plan: planSummary(plan)
    };
  });
}

export async function assignUserPlan(
  pool: Pool,
  accountId: string,
  userId: string,
  planId: number
): Promise<User> {
  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const userResult = await client.query<{
      id: string;
      accountId: string;
      createdAt: Date;
    }>(
      `
        SELECT
          id,
          account_id AS "accountId",
          created_at AS "createdAt"
        FROM users
        WHERE account_id = $1 AND id = $2
      `,
      [accountId, userId]
    );
    const user = userResult.rows[0];

    if (user === undefined) {
      throw new AssignmentUserNotFoundError();
    }

    const plan = await validatePlanAssignment(client, {
      accountId,
      planId,
      requiredScope: "user",
      defaultPredefinedPlanName: "Basic"
    });

    await client.query(
      `
        UPDATE users
        SET user_plan_id = $3
        WHERE account_id = $1 AND id = $2
      `,
      [accountId, userId, plan.id]
    );

    return {
      ...user,
      plan: planSummary(plan)
    };
  });
}
