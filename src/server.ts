import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  createPool,
  verifyDatabaseConnection,
  waitForDatabase
} from "./db/pool.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({
  checkDatabase: async () => verifyDatabaseConnection(pool)
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
