import { loadConfig } from "../config.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";
import { seedPredefinedPlans } from "./seed.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);

try {
  const appliedMigrations = await runMigrations(pool);
  const insertedPlans = await seedPredefinedPlans(pool);

  console.log(
    `Database initialized: ${appliedMigrations.length} migration(s) applied, ${insertedPlans} predefined plan(s) inserted.`
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Database initialization failed."
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
