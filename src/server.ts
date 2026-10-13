import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, waitForDatabase } from "./db/pool.js";

const config = loadConfig();
const app = buildApp();
const pool = createPool(config.DATABASE_URL);

try {
  await waitForDatabase(pool, {
    onRetry: (_error, nextAttempt) => {
      app.log.warn({ nextAttempt }, "PostgreSQL is not ready; retrying connection");
    }
  });

  app.addHook("onClose", async () => {
    await pool.end();
  });

  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error, "Application startup failed");
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}
