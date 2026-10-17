import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";

import { AppError } from "../shared/errors.js";
import { digestApiKey } from "../modules/accounts/api-key.js";

export const API_KEY_HEADER = "x-api-key";
const API_KEY_PATTERN = /^umq_[A-Za-z0-9_-]{43}$/;

export interface AuthenticatedAccount {
  id: string;
  name: string;
  plan: {
    id: number;
    name: string;
    scope: "account" | "user";
    monthlyLimit: number;
    maxUnitsPerRequest: number;
    revision: number;
  };
}

interface AuthenticatedAccountRow {
  id: string;
  name: string;
  planId: number;
  planName: string;
  planScope: "account" | "user";
  monthlyLimit: number;
  maxUnitsPerRequest: number;
  planRevision: number;
}

export type AuthenticateAccount = (
  apiKey: string
) => Promise<AuthenticatedAccount | null>;

declare module "fastify" {
  interface FastifyRequest {
    authenticatedAccount: AuthenticatedAccount | null;
  }
}

export function createApiKeyAuthenticator(
  pool: Pool,
  apiKeyPepper: string
): AuthenticateAccount {
  return async (apiKey) => {
    const apiKeyDigest = digestApiKey(apiKey, apiKeyPepper);
    const result = await pool.query<AuthenticatedAccountRow>(
      `
        SELECT
          accounts.id,
          accounts.name,
          plans.id AS "planId",
          plans.name AS "planName",
          plans.scope AS "planScope",
          plans.monthly_limit AS "monthlyLimit",
          plans.max_units_per_request AS "maxUnitsPerRequest",
          plans.revision AS "planRevision"
        FROM accounts
        JOIN plans ON plans.id = accounts.account_plan_id
        WHERE accounts.api_key_digest = $1
      `,
      [apiKeyDigest]
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      plan: {
        id: row.planId,
        name: row.planName,
        scope: row.planScope,
        monthlyLimit: row.monthlyLimit,
        maxUnitsPerRequest: row.maxUnitsPerRequest,
        revision: row.planRevision
      }
    };
  };
}

function readApiKey(request: FastifyRequest): string | null {
  const header = request.headers[API_KEY_HEADER];

  if (typeof header !== "string" || !API_KEY_PATTERN.test(header)) {
    return null;
  }

  return header;
}

export function createAuthenticateApiKeyHook(
  authenticateAccount: AuthenticateAccount
): preHandlerHookHandler {
  return async (request) => {
    const apiKey = readApiKey(request);

    if (apiKey === null) {
      throw new AppError(
        "A valid API key is required.",
        401,
        "UNAUTHORIZED"
      );
    }

    const account = await authenticateAccount(apiKey);

    if (account === null) {
      throw new AppError(
        "A valid API key is required.",
        401,
        "UNAUTHORIZED"
      );
    }

    request.authenticatedAccount = account;
  };
}
