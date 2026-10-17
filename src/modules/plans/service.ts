import type { Pool } from "pg";

import { withLockedAccountTransaction } from "../../db/account-transaction.js";
import type {
  CreateCustomPlanBody,
  PlanScope,
  UpdateCustomPlanBody
} from "../../shared/validation.js";

export type PlanOwner = "predefined" | "account";

export interface Plan {
  id: number;
  name: string;
  scope: PlanScope;
  monthlyLimit: number;
  requestLimit: number;
  revision: number;
  owner: PlanOwner;
}

interface PlanRow {
  id: number;
  name: string;
  scope: PlanScope;
  monthlyLimit: number;
  requestLimit: number;
  revision: number;
  ownerAccountId: string | null;
}

export type PlanMutationErrorCode =
  | "PLAN_NOT_FOUND"
  | "PREDEFINED_PLAN_READ_ONLY";

export class PlanMutationError extends Error {
  public constructor(
    public readonly code: PlanMutationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PlanMutationError";
  }
}

const planSelection = `
  SELECT
    id,
    name,
    scope,
    monthly_limit AS "monthlyLimit",
    max_units_per_request AS "requestLimit",
    revision,
    owner_account_id AS "ownerAccountId"
  FROM plans
`;

function mapPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    monthlyLimit: row.monthlyLimit,
    requestLimit: row.requestLimit,
    revision: row.revision,
    owner: row.ownerAccountId === null ? "predefined" : "account"
  };
}

export async function createCustomPlan(
  pool: Pool,
  accountId: string,
  input: CreateCustomPlanBody
): Promise<Plan> {
  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const result = await client.query<PlanRow>(
      `
        INSERT INTO plans (
          owner_account_id,
          scope,
          name,
          monthly_limit,
          max_units_per_request
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          name,
          scope,
          monthly_limit AS "monthlyLimit",
          max_units_per_request AS "requestLimit",
          revision,
          owner_account_id AS "ownerAccountId"
      `,
      [
        accountId,
        input.scope,
        input.name,
        input.monthlyLimit,
        input.requestLimit
      ]
    );
    const plan = result.rows[0];

    if (plan === undefined) {
      throw new Error("The custom plan was not returned after creation.");
    }

    return mapPlan(plan);
  });
}

export async function listPlans(
  pool: Pool,
  accountId: string,
  scope?: PlanScope
): Promise<Plan[]> {
  const result = await pool.query<PlanRow>(
    `
      ${planSelection}
      WHERE (owner_account_id IS NULL OR owner_account_id = $1)
        AND ($2::text IS NULL OR scope = $2)
      ORDER BY
        CASE WHEN owner_account_id IS NULL THEN 0 ELSE 1 END,
        id
    `,
    [accountId, scope ?? null]
  );

  return result.rows.map(mapPlan);
}

export async function getPlan(
  pool: Pool,
  accountId: string,
  planId: number
): Promise<Plan | null> {
  const result = await pool.query<PlanRow>(
    `
      ${planSelection}
      WHERE id = $1
        AND (owner_account_id IS NULL OR owner_account_id = $2)
    `,
    [planId, accountId]
  );
  const plan = result.rows[0];

  return plan === undefined ? null : mapPlan(plan);
}

export async function updateCustomPlan(
  pool: Pool,
  accountId: string,
  planId: number,
  input: UpdateCustomPlanBody
): Promise<Plan> {
  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const currentResult = await client.query<PlanRow>(
      `
        ${planSelection}
        WHERE id = $1
          AND (owner_account_id IS NULL OR owner_account_id = $2)
      `,
      [planId, accountId]
    );
    const current = currentResult.rows[0];

    if (current === undefined) {
      throw new PlanMutationError("PLAN_NOT_FOUND", "Plan not found.");
    }

    if (current.ownerAccountId === null) {
      throw new PlanMutationError(
        "PREDEFINED_PLAN_READ_ONLY",
        "Predefined plans cannot be modified."
      );
    }

    const updatedResult = await client.query<PlanRow>(
      `
        UPDATE plans
        SET
          name = COALESCE($3, name),
          monthly_limit = COALESCE($4, monthly_limit),
          max_units_per_request = COALESCE($5, max_units_per_request),
          revision = revision + 1,
          updated_at = now()
        WHERE id = $1 AND owner_account_id = $2
        RETURNING
          id,
          name,
          scope,
          monthly_limit AS "monthlyLimit",
          max_units_per_request AS "requestLimit",
          revision,
          owner_account_id AS "ownerAccountId"
      `,
      [
        planId,
        accountId,
        input.name ?? null,
        input.monthlyLimit ?? null,
        input.requestLimit ?? null
      ]
    );
    const updated = updatedResult.rows[0];

    if (updated === undefined) {
      throw new Error("The custom plan was not returned after update.");
    }

    return mapPlan(updated);
  });
}
