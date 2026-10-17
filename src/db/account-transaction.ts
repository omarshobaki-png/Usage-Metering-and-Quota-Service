import type { Pool, PoolClient } from "pg";

export class AccountNotFoundError extends Error {
  public constructor(accountId: string) {
    super(`Account "${accountId}" does not exist.`);
    this.name = "AccountNotFoundError";
  }
}

export async function withLockedAccountTransaction<T>(
  pool: Pool,
  accountId: string,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");

    const accountResult = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId]
    );

    if (accountResult.rows[0] === undefined) {
      throw new AccountNotFoundError(accountId);
    }

    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
