import { parseArgs } from "node:util";

import { ConfigurationError, loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { provisionAccount } from "../src/modules/accounts/provision-account.js";

function requireApiKeyPepper(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigurationError(
      "Invalid environment configuration: API_KEY_PEPPER is required for account provisioning."
    );
  }

  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      name: { type: "string", short: "n" },
      plan: { type: "string", short: "p", default: "Starter" }
    },
    allowPositionals: false,
    strict: true
  });

  if (values.name === undefined) {
    throw new Error(
      'Account name is required. Example: npm run account:create -- --name "Example Company" --plan Starter'
    );
  }

  const config = loadConfig();
  const apiKeyPepper = requireApiKeyPepper(config.API_KEY_PEPPER);
  const pool = createPool(config.DATABASE_URL);

  try {
    const account = await provisionAccount(pool, {
      name: values.name,
      planName: values.plan,
      apiKeyPepper
    });

    console.log("Account created successfully.");
    console.log(`Account ID: ${account.id}`);
    console.log(`Account name: ${account.name}`);
    console.log(`Plan: ${account.planName}`);
    console.log(`API key: ${account.apiKey}`);
    console.log("Save this API key now. It cannot be recovered later.");
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Account provisioning failed."
  );
  process.exitCode = 1;
}
