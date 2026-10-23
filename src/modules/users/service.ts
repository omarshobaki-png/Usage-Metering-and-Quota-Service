import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withLockedAccountTransaction } from "../../db/account-transaction.js";
import { validatePlanAssignment } from "../plans/assignment.js";
import type { PlanSummary } from "../plans/types.js";

const DEFAULT_USER_PLAN_NAME = "Basic";

export interface CreateUserInput {
  planId?: number;
}

export interface User {
  id: string;
  accountId: string;
  createdAt: Date;
  plan: PlanSummary;
}

interface UserRow {
  id: string;
  accountId: string;
  createdAt: Date;
  planId: number;
  planName: string;
  planScope: "account" | "user";
  monthlyLimit: number;
  maxUnitsPerRequest: number;
  planRevision: number;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    accountId: row.accountId,
    createdAt: row.createdAt,
    plan: {
      id: row.planId,
      name: row.planName,
      scope: row.planScope,
      monthlyLimit: row.monthlyLimit,
      maxUnitsPerRequest: row.maxUnitsPerRequest,
      revision: row.planRevision
    }
  };
}

export async function createUser(
  pool: Pool,
  accountId: string,
  input: CreateUserInput = {}
): Promise<User> {
  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const plan = await validatePlanAssignment(client, {
      accountId,
      planId: input.planId,
      requiredScope: "user",
      defaultPredefinedPlanName: DEFAULT_USER_PLAN_NAME
    });
    const userId = randomUUID();
    const userResult = await client.query<{
      id: string;
      accountId: string;
      createdAt: Date;
    }>(
      `
        INSERT INTO users (id, account_id, user_plan_id)
        VALUES ($1, $2, $3)
        RETURNING
          id,
          account_id AS "accountId",
          created_at AS "createdAt"
      `,
      [userId, accountId, plan.id]
    );
    const created = userResult.rows[0];

    if (created === undefined) {
      throw new Error("The user was not returned after creation.");
    }

    return {
      ...created,
      plan: {
        id: plan.id,
        name: plan.name,
        scope: plan.scope,
        monthlyLimit: plan.monthlyLimit,
        maxUnitsPerRequest: plan.maxUnitsPerRequest,
        revision: plan.revision
      }
    };
  });
}

export async function getUser(
  pool: Pool,
  accountId: string,
  userId: string
): Promise<User | null> {
  const result = await pool.query<UserRow>(
    `
      SELECT
        users.id,
        users.account_id AS "accountId",
        users.created_at AS "createdAt",
        plans.id AS "planId",
        plans.name AS "planName",
        plans.scope AS "planScope",
        plans.monthly_limit AS "monthlyLimit",
        plans.max_units_per_request AS "maxUnitsPerRequest",
        plans.revision AS "planRevision"
      FROM users
      JOIN plans ON plans.id = users.user_plan_id
      WHERE users.account_id = $1 AND users.id = $2
    `,
    [accountId, userId]
  );
  const row = result.rows[0];

  return row === undefined ? null : mapUser(row);
}
