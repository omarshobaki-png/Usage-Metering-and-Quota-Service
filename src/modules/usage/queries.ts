import type { Pool } from "pg";

import type { Clock } from "../../shared/clock.js";
import { InvalidRequestError } from "../../shared/errors.js";
import { usageMonthSchema } from "../../shared/validation.js";
import type { PlanSummary } from "../plans/types.js";

export type UsageBalance =
  | { id: string; consumed: number }
  | { id: string; consumed: number; monthlyLimit: number; remaining: number };

export interface AccountUsage {
  month: string;
  isCurrentMonth: boolean;
  account: UsageBalance;
}

export interface UserUsage extends AccountUsage {
  user: UsageBalance;
}

export interface UsageQueryOptions {
  clock?: Clock;
}

export interface AppliedRules {
  id: string;
  plan: PlanSummary;
  consumed: number;
  remaining: number;
}

export interface AccountRules {
  month: string;
  account: AppliedRules;
}

export interface UserRules extends AccountRules {
  user: AppliedRules;
}

interface UsageRow {
  month: string;
  isCurrentMonth: boolean;
  accountId: string;
  accountConsumed: number;
  accountPlan: PlanSummary;
  userId: string | null;
  userConsumed: number;
  userPlan: PlanSummary | null;
}

async function readUsage(
  pool: Pool,
  accountId: string,
  userId: string | null,
  month: string | undefined,
  options: UsageQueryOptions
): Promise<UsageRow | null> {
  if (month !== undefined && !usageMonthSchema.safeParse(month).success) {
    throw new InvalidRequestError("Query parameters are invalid.");
  }

  const result = await pool.query<UsageRow>(
    `
      WITH current_period AS (
        SELECT date_trunc('month',
          COALESCE($4::timestamptz, statement_timestamp()) AT TIME ZONE 'UTC'
        )::date AS current_month
      ), period AS (
        SELECT current_month, COALESCE($3::date, current_month) AS usage_month
        FROM current_period
      )
      SELECT
        to_char(period.usage_month, 'YYYY-MM') AS month,
        period.usage_month = period.current_month AS "isCurrentMonth",
        a.id AS "accountId", u.id AS "userId",
        COALESCE(au.consumed_units, 0) AS "accountConsumed",
        jsonb_build_object(
          'id', ap.id, 'name', ap.name, 'scope', ap.scope,
          'monthlyLimit', ap.monthly_limit,
          'maxUnitsPerRequest', ap.max_units_per_request, 'revision', ap.revision
        ) AS "accountPlan",
        COALESCE(uu.consumed_units, 0) AS "userConsumed",
        CASE WHEN up.id IS NOT NULL THEN jsonb_build_object(
          'id', up.id, 'name', up.name, 'scope', up.scope,
          'monthlyLimit', up.monthly_limit,
          'maxUnitsPerRequest', up.max_units_per_request, 'revision', up.revision
        ) END AS "userPlan"
      FROM accounts a
      JOIN plans ap ON ap.id = a.account_plan_id
      CROSS JOIN period
      LEFT JOIN users u ON u.account_id = a.id AND u.id = $2::uuid
      LEFT JOIN plans up ON up.id = u.user_plan_id
      LEFT JOIN account_monthly_usage au
        ON au.account_id = a.id AND au.usage_month = period.usage_month
      LEFT JOIN user_monthly_usage uu
        ON uu.account_id = a.id AND uu.user_id = u.id
        AND uu.usage_month = period.usage_month
      WHERE a.id = $1 AND ($2::uuid IS NULL OR u.id IS NOT NULL)
    `,
    [accountId, userId, month === undefined ? null : `${month}-01`,
      options.clock === undefined ? null : options.clock().toISOString()]
  );

  return result.rows[0] ?? null;
}

function balance(id: string, consumed: number, monthlyLimit: number, current: boolean): UsageBalance {
  return current
    ? { id, consumed, monthlyLimit, remaining: Math.max(0, monthlyLimit - consumed) }
    : { id, consumed };
}

function accountUsage(row: UsageRow): AccountUsage {
  return {
    month: row.month,
    isCurrentMonth: row.isCurrentMonth,
    account: balance(row.accountId, row.accountConsumed, row.accountPlan.monthlyLimit, row.isCurrentMonth)
  };
}

export async function readAccountUsage(
  pool: Pool,
  accountId: string,
  month?: string,
  options: UsageQueryOptions = {}
): Promise<AccountUsage | null> {
  const row = await readUsage(pool, accountId, null, month, options);
  return row === null ? null : accountUsage(row);
}

export async function readUserUsage(
  pool: Pool,
  accountId: string,
  userId: string,
  month?: string,
  options: UsageQueryOptions = {}
): Promise<UserUsage | null> {
  const row = await readUsage(pool, accountId, userId, month, options);
  if (row === null || row.userId === null || row.userPlan === null) return null;

  return {
    ...accountUsage(row),
    user: balance(row.userId, row.userConsumed, row.userPlan.monthlyLimit, row.isCurrentMonth)
  };
}

function appliedRules(id: string, consumed: number, plan: PlanSummary): AppliedRules {
  return { id, plan, consumed, remaining: Math.max(0, plan.monthlyLimit - consumed) };
}

// Always inspect the current UTC month. Historical decisions must continue to
// use their stored snapshots rather than joining these mutable definitions.
export async function readAccountRules(
  pool: Pool,
  accountId: string,
  options: UsageQueryOptions = {}
): Promise<AccountRules | null> {
  const row = await readUsage(pool, accountId, null, undefined, options);
  return row === null ? null : {
    month: row.month,
    account: appliedRules(row.accountId, row.accountConsumed, row.accountPlan)
  };
}

export async function readUserRules(
  pool: Pool,
  accountId: string,
  userId: string,
  options: UsageQueryOptions = {}
): Promise<UserRules | null> {
  const row = await readUsage(pool, accountId, userId, undefined, options);
  if (row === null || row.userId === null || row.userPlan === null) return null;
  return {
    month: row.month,
    account: appliedRules(row.accountId, row.accountConsumed, row.accountPlan),
    user: appliedRules(row.userId, row.userConsumed, row.userPlan)
  };
}
