import type { Pool } from "pg";

import type { LoadOptions } from "./config.js";
import type { LoadAccount } from "./fixtures.js";
import type { Measurements } from "./load.js";

export interface AccountReconciliation {
  accountId: string;
  months: string[];
  monthlyLimit: number;
  accountConsumed: number;
  sumUserConsumed: number;
  uniqueAcceptedDecisionUnits: number;
  decisionCount: number;
  uniqueDecisionCount: number;
  users: { userId: string; consumed: number; monthlyLimit: number; acceptedDecisionUnits: number }[];
}

export interface Reconciliation {
  passed: boolean;
  errors: string[];
  accountConsumed: number;
  sumUserConsumed: number;
  uniqueAcceptedDecisionUnits: number;
  acceptedDecisions: number;
  rejectedDecisions: number;
  accounts: AccountReconciliation[];
}

interface UsageRow { accountId: string; userId?: string; month: string; consumed: number }
interface LedgerRow {
  accountId: string; userId: string; month: string; decisions: number;
  uniqueDecisions: number; accepted: number; rejected: number; acceptedUnits: number;
  invalidActions: number; unexpectedRejections: number;
}
interface PlanRow {
  accountId: string; userId?: string; planId: number; monthlyLimit: number;
  requestLimit: number; revision: number; ownerId: string;
}

export async function reconcileLoad(
  pool: Pool, fixtures: LoadAccount[], options: LoadOptions, runId: string, measured: Measurements
): Promise<Reconciliation> {
  const client = await pool.connect();
  try {
    // Independent, read-only snapshot of durable counters and the decision ledger.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ids = fixtures.map((account) => account.id);
    const accountUsage = (await client.query<UsageRow>(`
      SELECT account_id AS "accountId", to_char(usage_month, 'YYYY-MM') AS month,
             consumed_units AS consumed FROM account_monthly_usage WHERE account_id = ANY($1::uuid[])
    `, [ids])).rows;
    const userUsage = (await client.query<UsageRow>(`
      SELECT account_id AS "accountId", user_id AS "userId", to_char(usage_month, 'YYYY-MM') AS month,
             consumed_units AS consumed FROM user_monthly_usage WHERE account_id = ANY($1::uuid[])
    `, [ids])).rows;
    const ledger = (await client.query<LedgerRow>(`
      SELECT account_id AS "accountId", user_id AS "userId", to_char(processed_month, 'YYYY-MM') AS month,
        count(*)::integer AS decisions, count(DISTINCT request_id)::integer AS "uniqueDecisions",
        count(*) FILTER (WHERE accepted)::integer AS accepted,
        count(*) FILTER (WHERE NOT accepted)::integer AS rejected,
        COALESCE(sum(requested_units) FILTER (WHERE accepted), 0)::integer AS "acceptedUnits",
        count(*) FILTER (WHERE requested_units <> 1 OR request_id NOT LIKE $2)::integer AS "invalidActions",
        count(*) FILTER (WHERE NOT accepted AND
          (blocking_scope IS DISTINCT FROM 'account' OR blocking_rule IS DISTINCT FROM 'monthly_limit'))::integer AS "unexpectedRejections"
      FROM request_decisions WHERE account_id = ANY($1::uuid[]) GROUP BY account_id, user_id, processed_month
    `, [ids, `${runId}:%`])).rows;
    const accountPlans = (await client.query<PlanRow>(`
      SELECT a.id AS "accountId", p.id AS "planId", p.owner_account_id AS "ownerId",
        p.monthly_limit AS "monthlyLimit", p.max_units_per_request AS "requestLimit", p.revision
      FROM accounts a JOIN plans p ON p.id = a.account_plan_id WHERE a.id = ANY($1::uuid[])
    `, [ids])).rows;
    const userPlans = (await client.query<PlanRow>(`
      SELECT u.account_id AS "accountId", u.id AS "userId", p.id AS "planId", p.owner_account_id AS "ownerId",
        p.monthly_limit AS "monthlyLimit", p.max_units_per_request AS "requestLimit", p.revision
      FROM users u JOIN plans p ON p.id = u.user_plan_id WHERE u.account_id = ANY($1::uuid[])
    `, [ids])).rows;
    await client.query("COMMIT");

    const errors: string[] = [];
    const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
    const check = (valid: boolean, code: string) => { if (!valid) errors.push(code); };
    const accounts = fixtures.map((fixture): AccountReconciliation => {
      const ownAccounts = accountUsage.filter((row) => row.accountId === fixture.id);
      const ownUsers = userUsage.filter((row) => row.accountId === fixture.id);
      const ownLedger = ledger.filter((row) => row.accountId === fixture.id);
      const months = [...new Set([...ownAccounts, ...ownUsers, ...ownLedger].map((row) => row.month))].sort();
      check(months.length === 1, `single_utc_month:${fixture.id}`);
      const plan = accountPlans.find((row) => row.accountId === fixture.id);
      check(plan?.planId === fixture.accountPlanId && plan.monthlyLimit === fixture.monthlyLimit &&
        plan.requestLimit === fixture.requestLimit && plan.revision === 1 && plan.ownerId === fixture.id,
      `fixed_account_plan:${fixture.id}`);
      check(userPlans.filter((row) => row.accountId === fixture.id).length === fixture.userIds.length,
        `user_assignments:${fixture.id}`);
      check(ownLedger.every((row) => fixture.userIds.includes(row.userId) && row.invalidActions === 0),
        `ledger_action_identity:${fixture.id}`);
      if (options.workload === "correctness") check(ownLedger.every((row) => row.unexpectedRejections === 0),
        `account_monthly_rejections:${fixture.id}`);
      for (const month of months) {
        const accountUnits = sum(ownAccounts.filter((r) => r.month === month), (r) => r.consumed);
        const userUnits = sum(ownUsers.filter((r) => r.month === month), (r) => r.consumed);
        const acceptedUnits = sum(ownLedger.filter((r) => r.month === month), (r) => r.acceptedUnits);
        check(accountUnits === userUnits && userUnits === acceptedUnits, `monthly_totals:${fixture.id}:${month}`);
        check(accountUnits <= fixture.monthlyLimit, `account_no_overspend:${fixture.id}:${month}`);
      }
      const users = fixture.userIds.map((userId) => {
        const currentPlan = userPlans.find((row) => row.accountId === fixture.id && row.userId === userId);
        check(currentPlan?.planId === fixture.userPlanId && currentPlan.monthlyLimit === fixture.userMonthlyLimit &&
          currentPlan.requestLimit === fixture.requestLimit && currentPlan.revision === 1 && currentPlan.ownerId === fixture.id,
        `fixed_user_plan:${userId}`);
        const usage = ownUsers.filter((row) => row.userId === userId);
        const decisions = ownLedger.filter((row) => row.userId === userId);
        for (const month of months) {
          const actual = sum(usage.filter((r) => r.month === month), (r) => r.consumed);
          check(actual === sum(decisions.filter((r) => r.month === month), (r) => r.acceptedUnits), `user_totals:${userId}:${month}`);
          check(actual <= fixture.userMonthlyLimit, `user_no_overspend:${userId}:${month}`);
        }
        return { userId, consumed: sum(usage, (r) => r.consumed), monthlyLimit: fixture.userMonthlyLimit,
          acceptedDecisionUnits: sum(decisions, (r) => r.acceptedUnits) };
      });
      const decisionCount = sum(ownLedger, (r) => r.decisions);
      const uniqueDecisionCount = sum(ownLedger, (r) => r.uniqueDecisions);
      check(decisionCount === uniqueDecisionCount, `unique_decisions:${fixture.id}`);
      return { accountId: fixture.id, months, monthlyLimit: fixture.monthlyLimit,
        accountConsumed: sum(ownAccounts, (r) => r.consumed), sumUserConsumed: sum(ownUsers, (r) => r.consumed),
        uniqueAcceptedDecisionUnits: sum(ownLedger, (r) => r.acceptedUnits), decisionCount, uniqueDecisionCount, users };
    });
    const acceptedDecisions = sum(ledger, (r) => r.accepted);
    const rejectedDecisions = sum(ledger, (r) => r.rejected);
    const counts = measured.counts;
    check(measured.attempted === options.requests && measured.completed === options.requests, "all_requests_completed");
    check(measured.maxInFlight <= options.concurrency, "bounded_workers");
    check(counts.unexpectedHttpStatus + counts.timeout + counts.networkError + counts.invalidResponse === 0, "no_unexpected_failures");
    check(sum(accounts, (r) => r.decisionCount) === options.requests, "one_decision_per_new_action");
    check(acceptedDecisions === counts.accepted && rejectedDecisions === counts.quotaRejected, "responses_match_durable_decisions");
    check(options.workload === "correctness"
      ? counts.accepted === 100 && counts.quotaRejected === 100
      : counts.accepted === options.requests && counts.quotaRejected === 0, "expected_workload_outcome");
    return { passed: errors.length === 0, errors, accounts, acceptedDecisions, rejectedDecisions,
      accountConsumed: sum(accounts, (r) => r.accountConsumed), sumUserConsumed: sum(accounts, (r) => r.sumUserConsumed),
      uniqueAcceptedDecisionUnits: sum(accounts, (r) => r.uniqueAcceptedDecisionUnits) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
