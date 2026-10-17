import type { Pool, PoolClient } from "pg";

import { withLockedAccountTransaction } from "../../db/account-transaction.js";
import type { Clock } from "../../shared/clock.js";
import { RequestIdConflictError } from "../../shared/errors.js";
import { consumeBodySchema, parseRequestBody } from "../../shared/validation.js";
import { validatePlanAssignment } from "../plans/assignment.js";
import {
  parseConsumptionDecision,
  type ConsumeRequest,
  type ConsumptionDecision
} from "./contract.js";
import { evaluateRules } from "./evaluate-rules.js";
import { getUtcMonth } from "./month.js";
import { parseConsumptionSnapshot } from "./snapshot.js";
import {
  ensureAccountUsageBucket,
  ensureUserUsageBucket,
  getAccountUsage,
  getUserUsage,
  incrementAccountUsage,
  incrementUserUsage
} from "./usage-repository.js";

interface CurrentAssignments {
  accountPlanId: number;
  userPlanId: number;
}

interface ExistingDecision {
  userId: string;
  units: number;
  snapshot: unknown;
}

export interface ConsumeOptions {
  // Test-only processing time; production reads PostgreSQL after the lock.
  clock?: Clock;
  testHooks?: {
    afterAccountIncrement?: (client: PoolClient) => void | Promise<void>;
    afterDecisionInsert?: (client: PoolClient) => void | Promise<void>;
  };
}

/**
 * One connection and one READ COMMITTED transaction:
 * 1. Lock the account in a standalone statement (the transaction helper).
 * 2. Read owned user, assignments, existing decision, and current plan rules.
 * 3. Capture processing time after the lock and derive one UTC month.
 * 4. Initialize/read buckets and evaluate all four rules.
 * 5. On acceptance, increment both totals; always record the valid decision.
 * 6. Commit before returning. Any exception rolls back and releases the client.
 */
export async function consume(
  pool: Pool,
  accountId: string,
  request: ConsumeRequest,
  options: ConsumeOptions = {}
): Promise<ConsumptionDecision | null> {
  const parsed = parseRequestBody(consumeBodySchema, request);
  const input = { ...parsed, userId: parsed.userId.toLowerCase() };

  return withLockedAccountTransaction(pool, accountId, async (client) => {
    const assignmentsResult = await client.query<CurrentAssignments>(
      `
        SELECT
          accounts.account_plan_id AS "accountPlanId",
          users.user_plan_id AS "userPlanId"
        FROM accounts
        JOIN users ON users.account_id = accounts.id
        WHERE accounts.id = $1 AND users.id = $2
      `,
      [accountId, input.userId]
    );
    const assignments = assignmentsResult.rows[0];

    if (assignments === undefined) {
      return null;
    }

    const existingResult = await client.query<ExistingDecision>(
      `
        SELECT
          user_id AS "userId",
          requested_units AS units,
          decision_snapshot AS snapshot
        FROM request_decisions
        WHERE account_id = $1 AND request_id = $2
      `,
      [accountId, input.requestId]
    );
    const existing = existingResult.rows[0];

    if (existing !== undefined) {
      if (existing.userId !== input.userId || existing.units !== input.units) {
        throw new RequestIdConflictError();
      }

      return parseConsumptionSnapshot(existing.snapshot).response;
    }

    // These reads happen in later statements after the account lock returns.
    const accountPlan = await validatePlanAssignment(client, {
      accountId,
      planId: assignments.accountPlanId,
      requiredScope: "account",
      defaultPredefinedPlanName: "Starter"
    });
    const userPlan = await validatePlanAssignment(client, {
      accountId,
      planId: assignments.userPlanId,
      requiredScope: "user",
      defaultPredefinedPlanName: "Basic"
    });

    let processedAt: Date;
    if (options.clock !== undefined) {
      processedAt = options.clock();
    } else {
      const timeResult = await client.query<{ processedAt: Date }>(
        'SELECT statement_timestamp() AS "processedAt"'
      );
      const timestamp = timeResult.rows[0]?.processedAt;
      if (timestamp === undefined) {
        throw new Error("The processing timestamp was not returned.");
      }
      processedAt = timestamp;
    }
    const month = getUtcMonth(processedAt);

    await ensureAccountUsageBucket(client, accountId, month);
    await ensureUserUsageBucket(client, accountId, input.userId, month);
    const accountConsumed = await getAccountUsage(client, accountId, month);
    const userConsumed = await getUserUsage(client, accountId, input.userId, month);
    const accountLimits = {
      monthlyLimit: accountPlan.monthlyLimit,
      maxUnitsPerRequest: accountPlan.maxUnitsPerRequest
    };
    const userLimits = {
      monthlyLimit: userPlan.monthlyLimit,
      maxUnitsPerRequest: userPlan.maxUnitsPerRequest
    };
    const evaluation = evaluateRules({
      units: input.units,
      account: { ...accountLimits, consumed: accountConsumed },
      user: { ...userLimits, consumed: userConsumed }
    });
    const decision = parseConsumptionDecision({
      ...input,
      processedAt: processedAt.toISOString(),
      month: month.slice(0, 7),
      accepted: evaluation.accepted,
      blockedBy: evaluation.blockedBy,
      account: {
        ...evaluation.account,
        plan: { id: accountPlan.id, revision: accountPlan.revision }
      },
      user: {
        ...evaluation.user,
        plan: { id: userPlan.id, revision: userPlan.revision }
      }
    });

    if (evaluation.accepted) {
      const accountTotal = await incrementAccountUsage(client, accountId, month, input.units);
      await options.testHooks?.afterAccountIncrement?.(client);
      const userTotal = await incrementUserUsage(client, accountId, input.userId, month, input.units);

      if (accountTotal !== decision.account.consumed || userTotal !== decision.user.consumed) {
        throw new Error("Persisted usage does not match the evaluated totals.");
      }
    }

    const snapshot = parseConsumptionSnapshot({
      response: decision,
      evaluatedLimits: { account: accountLimits, user: userLimits }
    });
    await client.query(
      `
        INSERT INTO request_decisions (
          account_id, request_id, user_id, requested_units,
          processed_at, processed_month, accepted, decision_reason,
          blocking_rule, blocking_scope, account_plan_id, user_plan_id,
          account_plan_revision, user_plan_revision, decision_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      `,
      [
        accountId,
        input.requestId,
        input.userId,
        input.units,
        processedAt,
        month,
        decision.accepted,
        decision.accepted ? "accepted" : "quota_exceeded",
        decision.blockedBy?.rule ?? null,
        decision.blockedBy?.scope ?? null,
        accountPlan.id,
        userPlan.id,
        accountPlan.revision,
        userPlan.revision,
        JSON.stringify(snapshot)
      ]
    );
    await options.testHooks?.afterDecisionInsert?.(client);

    return snapshot.response;
  });
}
