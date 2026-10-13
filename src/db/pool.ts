import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 2_000
  });
}

export interface DatabaseWaitOptions {
  maxAttempts?: number;
  delayMs?: number;
  onRetry?: (error: unknown, nextAttempt: number) => void;
}

export class DatabaseConnectionError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "DatabaseConnectionError";
  }
}

export async function verifyDatabaseConnection(pool: Pool): Promise<void> {
  const result = await pool.query<{ value: number }>("SELECT 1 AS value");

  if (result.rows[0]?.value !== 1) {
    throw new DatabaseConnectionError(
      "PostgreSQL returned an unexpected result for SELECT 1.",
      undefined
    );
  }
}

export async function waitForDatabase(
  pool: Pool,
  options: DatabaseWaitOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 10;
  const delayMs = options.delayMs ?? 1_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await verifyDatabaseConnection(pool);
      return;
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        options.onRetry?.(error, attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new DatabaseConnectionError(
    `PostgreSQL was unavailable after ${maxAttempts} connection attempts.`,
    lastError
  );
}
