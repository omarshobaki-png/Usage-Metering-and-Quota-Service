import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { normalizeServiceUrl, runDemoScenario } from "./client.js";
import { createDemoFixture } from "./setup.js";


async function main(): Promise<void> {
  const config = loadConfig();
  const serviceUrl = normalizeServiceUrl(
    process.env.DEMO_SERVICE_URL ?? "http://api:3000"
  );
  const pool = createPool(config.DATABASE_URL);

  try {
    const fixture = await createDemoFixture(pool, {
      serviceUrl,
      apiKeyPepper: config.API_KEY_PEPPER
    });
    console.log(`Created fresh dedicated demo account ${fixture.accountId}.`);
    console.log("Created three custom plans and two users through the API; key kept in memory.");
    await runDemoScenario(fixture.config);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Compose demo failed.");
  process.exitCode = 1;
}
