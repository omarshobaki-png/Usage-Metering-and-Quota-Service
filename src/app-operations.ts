import type { Pool } from "pg";

import type { BuildAppOptions } from "./app.js";
import { verifyDatabaseConnection } from "./db/pool.js";
import { createApiKeyAuthenticator } from "./middleware/authenticate-api-key.js";
import { assignAccountPlan, assignUserPlan } from "./modules/plans/assignment.js";
import { createCustomPlan, getPlan, listPlans, updateCustomPlan } from "./modules/plans/service.js";
import { consume, type ConsumeOptions } from "./modules/usage/consume.js";
import { readHistory } from "./modules/usage/history.js";
import { readAccountUsage, readUserUsage, readAccountRules, readUserRules } from "./modules/usage/queries.js";
import { createUser, getUser } from "./modules/users/service.js";

export function createAppOperations(
  pool: Pool,
  apiKeyPepper: string,
  options: ConsumeOptions = {}
): BuildAppOptions {
  return {
    checkDatabase: async () => verifyDatabaseConnection(pool),
    authenticateAccount: createApiKeyAuthenticator(pool, apiKeyPepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(pool, accountId, input),
      getUser: async (accountId, userId) => getUser(pool, accountId, userId)
    },
    planOperations: {
      createCustomPlan: async (accountId, input) => createCustomPlan(pool, accountId, input),
      listPlans: async (accountId, scope) => listPlans(pool, accountId, scope),
      getPlan: async (accountId, planId) => getPlan(pool, accountId, planId),
      updateCustomPlan: async (accountId, planId, input) => updateCustomPlan(pool, accountId, planId, input)
    },
    assignmentOperations: {
      assignAccountPlan: async (accountId, planId) => assignAccountPlan(pool, accountId, planId),
      assignUserPlan: async (accountId, userId, planId) => assignUserPlan(pool, accountId, userId, planId)
    },
    consumptionOperations: {
      consume: async (accountId, input) => consume(pool, accountId, input, options)
    },
    usageOperations: {
      readAccountUsage: async (accountId, month) => readAccountUsage(pool, accountId, month, options),
      readUserUsage: async (accountId, userId, month) => readUserUsage(pool, accountId, userId, month, options)
    },
    ruleOperations: {
      readAccountRules: async (accountId) => readAccountRules(pool, accountId, options),
      readUserRules: async (accountId, userId) => readUserRules(pool, accountId, userId, options)
    },
    historyOperations: {
      readHistory: async (accountId, query) => readHistory(pool, accountId, query)
    }
  };
}
