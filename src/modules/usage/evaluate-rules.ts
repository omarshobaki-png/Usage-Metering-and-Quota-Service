import type { QuotaRule, QuotaScope } from "./contract.js";

export interface QuotaState {
  readonly monthlyLimit: number;
  readonly maxUnitsPerRequest: number;
  readonly consumed: number;
}

export interface EvaluateRulesInput {
  readonly units: number;
  readonly account: QuotaState;
  readonly user: QuotaState;
}

export interface QuotaBalance {
  readonly consumed: number;
  readonly remaining: number;
}

interface RuleEvaluationBalances {
  readonly account: QuotaBalance;
  readonly user: QuotaBalance;
}

export type RuleEvaluation = RuleEvaluationBalances & (
  | { readonly accepted: true; readonly blockedBy: null }
  | {
      readonly accepted: false;
      readonly blockedBy: {
        readonly scope: QuotaScope;
        readonly rule: QuotaRule;
        readonly limit: number;
      };
    }
);

/**
 * Evaluate validated quantities: units is positive; usage and limits are
 * non-negative integers, all bounded by MAX_QUANTITY. Usage may exceed a
 * monthly limit after a downgrade. Callers validate input before evaluation.
 *
 * Results describe proposed balances only; this function performs no writes.
 */
export function evaluateRules(input: EvaluateRulesInput): RuleEvaluation {
  const { units, account, user } = input;
  const accountRemaining = Math.max(0, account.monthlyLimit - account.consumed);
  const userRemaining = Math.max(0, user.monthlyLimit - user.consumed);

  // Rejections preserve both totals, including when only one scope is blocked.
  const currentBalances: RuleEvaluationBalances = {
    account: { consumed: account.consumed, remaining: accountRemaining },
    user: { consumed: user.consumed, remaining: userRemaining }
  };

  // This order is part of the documented first-blocker contract.
  if (units > account.maxUnitsPerRequest) {
    return {
      ...currentBalances,
      accepted: false,
      blockedBy: {
        scope: "account",
        rule: "max_units_per_request",
        limit: account.maxUnitsPerRequest
      }
    };
  }

  if (units > user.maxUnitsPerRequest) {
    return {
      ...currentBalances,
      accepted: false,
      blockedBy: {
        scope: "user",
        rule: "max_units_per_request",
        limit: user.maxUnitsPerRequest
      }
    };
  }

  if (units > accountRemaining) {
    return {
      ...currentBalances,
      accepted: false,
      blockedBy: {
        scope: "account",
        rule: "monthly_limit",
        limit: account.monthlyLimit
      }
    };
  }

  if (units > userRemaining) {
    return {
      ...currentBalances,
      accepted: false,
      blockedBy: {
        scope: "user",
        rule: "monthly_limit",
        limit: user.monthlyLimit
      }
    };
  }

  // Add only after both monthly checks prove the proposed totals fit.
  return {
    accepted: true,
    blockedBy: null,
    account: {
      consumed: account.consumed + units,
      remaining: accountRemaining - units
    },
    user: {
      consumed: user.consumed + units,
      remaining: userRemaining - units
    }
  };
}
