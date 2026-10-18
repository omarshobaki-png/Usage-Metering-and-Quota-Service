import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  createPool,
  verifyDatabaseConnection,
  waitForDatabase
} from "./db/pool.js";
import { createApiKeyAuthenticator } from "./middleware/authenticate-api-key.js";
import {
  assignAccountPlan,
  assignUserPlan
} from "./modules/plans/assignment.js";
import {
  createCustomPlan,
  getPlan,
  listPlans,
  updateCustomPlan
} from "./modules/plans/service.js";
import { createUser, getUser } from "./modules/users/service.js";
import { consume } from "./modules/usage/consume.js";
import { readHistory } from "./modules/usage/history.js";
import {
  readAccountUsage,
  readUserUsage,
  readAccountRules,
  readUserRules
} from "./modules/usage/queries.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({
  checkDatabase: async () => verifyDatabaseConnection(pool),
  authenticateAccount: createApiKeyAuthenticator(pool, config.API_KEY_PEPPER),
  userOperations: {
    createUser: async (accountId, input) => createUser(pool, accountId, input),
    getUser: async (accountId, userId) => getUser(pool, accountId, userId)
  },
  planOperations: {
    createCustomPlan: async (accountId, input) =>
      createCustomPlan(pool, accountId, input),
    listPlans: async (accountId, scope) => listPlans(pool, accountId, scope),
    getPlan: async (accountId, planId) => getPlan(pool, accountId, planId),
    updateCustomPlan: async (accountId, planId, input) =>
      updateCustomPlan(pool, accountId, planId, input)
  },
  assignmentOperations: {
    assignAccountPlan: async (accountId, planId) =>
      assignAccountPlan(pool, accountId, planId),
    assignUserPlan: async (accountId, userId, planId) =>
      assignUserPlan(pool, accountId, userId, planId)
  },
  consumptionOperations: {
    consume: async (accountId, input) => consume(pool, accountId, input)
  },
  usageOperations: {
    readAccountUsage: async (accountId, month) => readAccountUsage(pool, accountId, month),
    readUserUsage: async (accountId, userId, month) => readUserUsage(pool, accountId, userId, month)
  },
  ruleOperations: {
    readAccountRules: async (accountId) => readAccountRules(pool, accountId),
    readUserRules: async (accountId, userId) => readUserRules(pool, accountId, userId)
  },
  historyOperations: {
    readHistory: async (accountId, query) => readHistory(pool, accountId, query)
  }
});

pool.on("error", () => {
  app.log.error("PostgreSQL pool lost an idle connection");
});

app.addHook("onClose", async () => {
  await pool.end();
});

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  app.log.info({ signal }, "Graceful shutdown started");

  try {
    await app.close();
    app.log.info({ signal }, "Graceful shutdown complete");
  } catch (error) {
    app.log.error({ error, signal }, "Graceful shutdown failed");
    process.exitCode = 1;
  }
}

try {
  await waitForDatabase(pool, {
    onRetry: (_error, nextAttempt) => {
      app.log.warn({ nextAttempt }, "PostgreSQL is not ready; retrying connection");
    }
  });

  await app.listen({ host: config.HOST, port: config.PORT });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  app.log.error(error, "Application startup failed");
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}
