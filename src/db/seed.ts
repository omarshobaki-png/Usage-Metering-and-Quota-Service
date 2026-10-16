import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type { Pool } from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

export type PlanScope = "account" | "user";

export interface PredefinedPlan {
  id: number;
  scope: PlanScope;
  name: string;
  monthlyLimit: number;
  maxUnitsPerRequest: number;
}

export const predefinedPlans: readonly PredefinedPlan[] = [
  {
    id: 1,
    scope: "account",
    name: "Starter",
    monthlyLimit: 10_000,
    maxUnitsPerRequest: 100
  },
  {
    id: 2,
    scope: "account",
    name: "Pro",
    monthlyLimit: 100_000,
    maxUnitsPerRequest: 1_000
  },
  {
    id: 3,
    scope: "user",
    name: "Basic",
    monthlyLimit: 1_000,
    maxUnitsPerRequest: 20
  },
  {
    id: 4,
    scope: "user",
    name: "Premium",
    monthlyLimit: 10_000,
    maxUnitsPerRequest: 100
  }
];

export async function seedPredefinedPlans(pool: Pool): Promise<number> {
  const client = await pool.connect();
  let insertedCount = 0;

  try {
    await client.query("BEGIN");

    for (const plan of predefinedPlans) {
      const result = await client.query(
        `
          INSERT INTO plans (
            id,
            owner_account_id,
            scope,
            name,
            monthly_limit,
            max_units_per_request
          )
          VALUES ($1, NULL, $2, $3, $4, $5)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          plan.id,
          plan.scope,
          plan.name,
          plan.monthlyLimit,
          plan.maxUnitsPerRequest
        ]
      );

      insertedCount += result.rowCount ?? 0;
    }

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('plans', 'id'),
        COALESCE(max(id), 1),
        count(*) > 0
      )
      FROM plans
    `);

    await client.query("COMMIT");
    return insertedCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  try {
    const insertedCount = await seedPredefinedPlans(pool);
    console.log(`Inserted ${insertedCount} predefined plan(s).`);
  } finally {
    await pool.end();
  }
}

const invokedFile = process.argv[1];

if (
  invokedFile !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedFile)).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Plan seeding failed.");
    process.exitCode = 1;
  }
}
