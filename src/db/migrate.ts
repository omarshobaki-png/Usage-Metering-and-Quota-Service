import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";

const migrationsDirectory = resolve(process.cwd(), "src/db/migrations");
const migrationFilenamePattern = /^[a-z][a-z0-9_]*\.sql$/;

export async function runMigrations(pool: Pool): Promise<string[]> {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((filename) => migrationFilenamePattern.test(filename))
    .sort();
  const client = await pool.connect();
  const newlyApplied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations"
    );
    const appliedVersions = new Set(
      appliedResult.rows.map((row) => row.version)
    );

    for (const filename of migrationFiles) {
      if (appliedVersions.has(filename)) {
        continue;
      }

      const sql = await readFile(resolve(migrationsDirectory, filename), "utf8");
      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        newlyApplied.push(filename);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${filename} failed.`, { cause: error });
      }
    }

    return newlyApplied;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  try {
    const applied = await runMigrations(pool);

    if (applied.length === 0) {
      console.log("No pending migrations.");
    } else {
      for (const filename of applied) {
        console.log(`Applied migration: ${filename}`);
      }
    }
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
    console.error(error instanceof Error ? error.message : "Migration failed.");
    process.exitCode = 1;
  }
}
