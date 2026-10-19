import type { Pool } from "pg";
import { z } from "zod";

import { AppError, InvalidRequestError } from "../../shared/errors.js";
import { usageMonthSchema, userIdSchema, type HistoryQuery } from "../../shared/validation.js";
import type { ConsumptionDecision } from "./contract.js";
import { parseConsumptionSnapshot, type ConsumptionSnapshot } from "./snapshot.js";

// BIGINT pagination positions stay decimal strings, never lossy JS numbers.
const sequenceSchema = z.string().max(19).regex(/^[1-9][0-9]*$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const cursorSchema = z.strictObject({
  version: z.literal(1),
  accountId: userIdSchema,
  userId: userIdSchema.nullable(),
  month: usageMonthSchema.nullable(),
  upper: sequenceSchema,
  before: sequenceSchema
}).refine((cursor) => BigInt(cursor.before) <= BigInt(cursor.upper));
type HistoryCursor = z.infer<typeof cursorSchema>;

export type HistoryEntry = ConsumptionDecision & {
  sequence: string;
  evaluatedLimits: ConsumptionSnapshot["evaluatedLimits"];
};

export interface HistoryPage {
  decisions: HistoryEntry[];
  nextCursor: string | null;
}

function decodeCursor(value: string): HistoryCursor {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("Noncanonical cursor.");
    return cursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  } catch {
    throw new InvalidRequestError("History cursor is invalid.");
  }
}

export async function readHistory(pool: Pool, accountId: string, query: HistoryQuery): Promise<HistoryPage> {
  const userId = query.userId?.toLowerCase() ?? null;
  const month = query.month ?? null;
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (cursor !== null && (
    cursor.accountId !== accountId || cursor.userId !== userId || cursor.month !== month
  )) {
    throw new InvalidRequestError("History cursor does not match this account and filters.");
  }

  if (userId !== null) {
    const owned = await pool.query("SELECT id FROM users WHERE account_id = $1 AND id = $2", [accountId, userId]);
    if (owned.rows.length === 0) throw new AppError("User not found.", 404, "USER_NOT_FOUND");
  }

  const result = await pool.query<{ sequence: string; snapshot: unknown }>(
    `SELECT decision_sequence::text AS sequence, decision_snapshot AS snapshot
     FROM request_decisions
     WHERE account_id = $1
       AND ($2::uuid IS NULL OR user_id = $2::uuid)
       AND ($3::date IS NULL OR processed_month = $3::date)
       AND ($4::bigint IS NULL OR decision_sequence <= $4::bigint)
       AND ($5::bigint IS NULL OR decision_sequence < $5::bigint)
     ORDER BY decision_sequence DESC
     LIMIT $6`,
    [accountId, userId, month === null ? null : `${month}-01`, cursor?.upper ?? null,
      cursor?.before ?? null, query.limit + 1]
  );
  const rows = result.rows.slice(0, query.limit);
  const decisions = rows.map((row): HistoryEntry => {
    const snapshot = parseConsumptionSnapshot(row.snapshot);
    return { ...snapshot.response, sequence: row.sequence, evaluatedLimits: snapshot.evaluatedLimits };
  });
  const first = rows[0];
  const last = rows.at(-1);
  const nextCursor = result.rows.length > query.limit && first !== undefined && last !== undefined
    ? Buffer.from(JSON.stringify({
        version: 1, accountId, userId, month,
        upper: cursor?.upper ?? first.sequence, before: last.sequence
      } satisfies HistoryCursor)).toString("base64url")
    : null;
  return { decisions, nextCursor };
}
