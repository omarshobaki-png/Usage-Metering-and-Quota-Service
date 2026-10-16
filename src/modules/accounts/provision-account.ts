import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { digestApiKey, generateApiKey } from "./api-key.js";

const DEFAULT_ACCOUNT_PLAN = "Starter";
const MAX_ACCOUNT_NAME_LENGTH = 200;
const MINIMUM_PEPPER_LENGTH = 16;

interface AccountPlanRow {
  id: number;
  name: string;
  scope: "account" | "user";
}

interface CreatedAccountRow {
  createdAt: Date;
}

export interface ProvisionAccountInput {
  name: string;
  planName?: string;
  apiKeyPepper: string;
}

export interface ProvisionedAccount {
  id: string;
  name: string;
  planId: number;
  planName: string;
  apiKey: string;
  createdAt: Date;
}

export class AccountProvisioningError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AccountProvisioningError";
  }
}

function normalizeRequiredValue(value: string, label: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new AccountProvisioningError(`${label} must not be empty.`);
  }

  return normalized;
}

export async function provisionAccount(
  pool: Pool,
  input: ProvisionAccountInput
): Promise<ProvisionedAccount> {
  const name = normalizeRequiredValue(input.name, "Account name");
  const planName = normalizeRequiredValue(
    input.planName ?? DEFAULT_ACCOUNT_PLAN,
    "Plan name"
  );

  if (name.length > MAX_ACCOUNT_NAME_LENGTH) {
    throw new AccountProvisioningError(
      `Account name must not exceed ${MAX_ACCOUNT_NAME_LENGTH} characters.`
    );
  }

  if (input.apiKeyPepper.length < MINIMUM_PEPPER_LENGTH) {
    throw new AccountProvisioningError(
      `API_KEY_PEPPER must contain at least ${MINIMUM_PEPPER_LENGTH} characters.`
    );
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const planResult = await client.query<AccountPlanRow>(
      `
        SELECT id, name, scope
        FROM plans
        WHERE owner_account_id IS NULL AND lower(name) = lower($1)
        ORDER BY id
        LIMIT 1
      `,
      [planName]
    );
    const plan = planResult.rows[0];

    if (plan === undefined) {
      throw new AccountProvisioningError(
        `Predefined plan "${planName}" does not exist.`
      );
    }

    if (plan.scope !== "account") {
      throw new AccountProvisioningError(
        `Plan "${plan.name}" has ${plan.scope} scope and cannot be assigned to an account.`
      );
    }

    const accountId = randomUUID();
    const apiKey = generateApiKey();
    const apiKeyDigest = digestApiKey(apiKey, input.apiKeyPepper);
    const accountResult = await client.query<CreatedAccountRow>(
      `
        INSERT INTO accounts (id, name, api_key_digest, account_plan_id)
        VALUES ($1, $2, $3, $4)
        RETURNING created_at AS "createdAt"
      `,
      [accountId, name, apiKeyDigest, plan.id]
    );
    const createdAt = accountResult.rows[0]?.createdAt;

    if (createdAt === undefined) {
      throw new AccountProvisioningError(
        "The account was not returned after creation."
      );
    }

    await client.query("COMMIT");

    return {
      id: accountId,
      name,
      planId: plan.id,
      planName: plan.name,
      apiKey,
      createdAt
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
