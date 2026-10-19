import { performance } from "node:perf_hooks";

import type { Pool } from "pg";
import { z } from "zod";

const count = z.number().int().nonnegative();
const countsSchema = z.strictObject({
  backends: count, active: count, lockWaiting: count, accountLockWaiting: count,
  lockEvents: z.record(z.string(), count)
}).refine((value) => value.accountLockWaiting <= value.lockWaiting && value.lockWaiting <= value.active && value.active <= value.backends &&
  Object.values(value.lockEvents).reduce((a, b) => a + b, 0) === value.lockWaiting, "Inconsistent backend counts.");
export type LockCounts = z.infer<typeof countsSchema>;
export type LockSample = LockCounts & { elapsedMs: number };

// Only aggregate activity for the API's client address/application. Never return
// query text, backend PIDs, credentials, or unrelated tenant/account information.
export async function readLockCounts(pool: Pool, clientAddress: string, applicationName: string): Promise<LockCounts> {
  const rows = (await pool.query<{
    state: string; waitType: string | null; waitEvent: string | null; accountLock: boolean; blocked: boolean; count: number;
  }>(`
    SELECT state, wait_event_type AS "waitType", wait_event AS "waitEvent",
      query LIKE '%SELECT id FROM accounts WHERE id = $1 FOR UPDATE%' AS "accountLock",
      cardinality(pg_blocking_pids(pid)) > 0 AS blocked, count(*)::integer AS count
    FROM pg_stat_activity
    WHERE datname = current_database() AND backend_type = 'client backend'
      AND client_addr = $1::inet AND application_name = $2
    GROUP BY state, wait_event_type, wait_event, "accountLock", blocked
  `, [clientAddress, applicationName])).rows;
  const result: LockCounts = { backends: 0, active: 0, lockWaiting: 0, accountLockWaiting: 0, lockEvents: {} };
  for (const row of rows) {
    result.backends += row.count;
    if (row.state === "active") result.active += row.count;
    if (row.waitType === "Lock" && row.blocked) {
      result.lockWaiting += row.count;
      if (row.accountLock) result.accountLockWaiting += row.count;
      const event = row.waitEvent ?? "unknown";
      result.lockEvents[event] = (result.lockEvents[event] ?? 0) + row.count;
    }
  }
  return countsSchema.parse(result);
}

export function summarizeLocks(samples: LockSample[]) {
  if (samples.length === 0) throw new Error("No in-load lock samples were captured.");
  for (const sample of samples) {
    countsSchema.parse({ backends: sample.backends, active: sample.active, lockWaiting: sample.lockWaiting,
      accountLockWaiting: sample.accountLockWaiting, lockEvents: sample.lockEvents });
    if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) throw new Error("Invalid sample time.");
  }
  const mean = (field: "backends" | "active" | "lockWaiting" | "accountLockWaiting") =>
    samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  const events: Record<string, number> = {};
  for (const sample of samples) for (const [event, observations] of Object.entries(sample.lockEvents)) events[event] = (events[event] ?? 0) + observations;
  return { sampleCount: samples.length, samplesWithAccountLockWait: samples.filter((sample) => sample.accountLockWaiting > 0).length,
    fractionWithAccountLockWait: samples.filter((sample) => sample.accountLockWaiting > 0).length / samples.length,
    meanBackends: mean("backends"), meanActive: mean("active"), meanLockWaiting: mean("lockWaiting"),
    meanAccountLockWaiting: mean("accountLockWaiting"), peakAccountLockWaiting: Math.max(...samples.map((sample) => sample.accountLockWaiting)),
    lockEventObservations: events };
}

export async function observeWork<T>(observe: () => Promise<LockCounts>, work: () => Promise<T>, intervalMs = 25) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error("Invalid observation interval.");
  const began = performance.now();
  const samples: LockSample[] = [];
  let active = true;
  let observationFailed = false;
  const pending = work().finally(() => { active = false; });
  const polling = (async () => {
    while (active) {
      try {
        const sample = await observe();
        if (active) samples.push({ ...sample, elapsedMs: performance.now() - began });
      } catch { observationFailed = true; return; }
      if (active) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  let result: T;
  try { result = await pending; } finally { active = false; await polling; }
  if (observationFailed) throw new Error("Lock observation failed; no diagnostic success claimed.");
  return { result, samples, summary: summarizeLocks(samples) };
}
