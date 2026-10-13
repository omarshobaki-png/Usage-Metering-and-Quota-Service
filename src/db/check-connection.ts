import { loadConfig } from "../config.js";
import { createPool, waitForDatabase } from "./pool.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  await waitForDatabase(pool, {
    maxAttempts: 5,
    delayMs: 1_000,
    onRetry: (_error, nextAttempt) => {
      console.warn(`PostgreSQL is not ready; trying attempt ${nextAttempt} of 5.`);
    }
  });

  console.log("Database connection successful: SELECT 1 returned 1.");
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`Database connection failed: ${message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
