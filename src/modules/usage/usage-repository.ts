import type { PoolClient } from "pg";

import { unitsSchema } from "../../shared/validation.js";
import type { UtcMonth } from "./month.js";

interface UsageRow {
  consumed: number;
}

export class UsageBucketNotFoundError extends Error {
  public constructor() {
    super("Usage bucket not found for this account, subject, and month.");
    this.name = "UsageBucketNotFoundError";
  }
}

// All operations use the caller's checked-out connection. The caller owns
// BEGIN/COMMIT/ROLLBACK and must lock the account before coordinated mutations.
export async function getAccountUsage(
  client: PoolClient,
  accountId: string,
  month: UtcMonth
): Promise<number> {
  const result = await client.query<UsageRow>(
    `
      SELECT consumed_units AS consumed
      FROM account_monthly_usage
      WHERE account_id = $1 AND usage_month = $2
    `,
    [accountId, month]
  );

  return result.rows[0]?.consumed ?? 0;
}

export async function getUserUsage(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: UtcMonth
): Promise<number> {
  const result = await client.query<UsageRow>(
    `
      SELECT consumed_units AS consumed
      FROM user_monthly_usage
      WHERE account_id = $1 AND user_id = $2 AND usage_month = $3
    `,
    [accountId, userId, month]
  );

  return result.rows[0]?.consumed ?? 0;
}

export async function ensureAccountUsageBucket(
  client: PoolClient,
  accountId: string,
  month: UtcMonth
): Promise<void> {
  await client.query(
    `
      INSERT INTO account_monthly_usage (account_id, usage_month)
      VALUES ($1, $2)
      ON CONFLICT (account_id, usage_month) DO NOTHING
    `,
    [accountId, month]
  );
}

export async function ensureUserUsageBucket(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: UtcMonth
): Promise<void> {
  await client.query(
    `
      INSERT INTO user_monthly_usage (account_id, user_id, usage_month)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, usage_month) DO NOTHING
    `,
    [accountId, userId, month]
  );

  // A conflict can be an existing bucket for this user under another account.
  // Never treat that as successfully initializing a bucket for the caller.
  const result = await client.query<UsageRow>(
    `
      SELECT consumed_units AS consumed
      FROM user_monthly_usage
      WHERE account_id = $1 AND user_id = $2 AND usage_month = $3
    `,
    [accountId, userId, month]
  );

  if (result.rows[0] === undefined) {
    throw new UsageBucketNotFoundError();
  }
}

export async function incrementAccountUsage(
  client: PoolClient,
  accountId: string,
  month: UtcMonth,
  units: number
): Promise<number> {
  const amount = unitsSchema.parse(units);
  const result = await client.query<UsageRow>(
    `
      UPDATE account_monthly_usage
      SET consumed_units = consumed_units + $3, updated_at = clock_timestamp()
      WHERE account_id = $1 AND usage_month = $2
      RETURNING consumed_units AS consumed
    `,
    [accountId, month, amount]
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new UsageBucketNotFoundError();
  }

  return row.consumed;
}

export async function incrementUserUsage(
  client: PoolClient,
  accountId: string,
  userId: string,
  month: UtcMonth,
  units: number
): Promise<number> {
  const amount = unitsSchema.parse(units);
  const result = await client.query<UsageRow>(
    `
      UPDATE user_monthly_usage
      SET consumed_units = consumed_units + $4, updated_at = clock_timestamp()
      WHERE account_id = $1 AND user_id = $2 AND usage_month = $3
      RETURNING consumed_units AS consumed
    `,
    [accountId, userId, month, amount]
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new UsageBucketNotFoundError();
  }

  return row.consumed;
}
