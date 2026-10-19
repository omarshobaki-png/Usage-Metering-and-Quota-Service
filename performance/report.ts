import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const count = z.number().int().nonnegative();
const duration = z.number().nonnegative();
const percentile = duration.nullable();
const measurements = z.strictObject({
  attempted: count, completed: count, maxInFlight: count, elapsedMs: duration,
  completedPerSecond: duration, acceptedPerSecond: duration,
  latencyMs: z.strictObject({ sampleCount: count, p50: percentile, p95: percentile, p99: percentile }),
  counts: z.strictObject({ accepted: count, quotaRejected: count, unexpectedHttpStatus: count,
    timeout: count, networkError: count, invalidResponse: count }),
  httpStatuses: z.record(z.string(), count), retries: z.literal(0), latencyScope: z.string()
});
const account = z.strictObject({
  accountId: z.uuid(), months: z.array(z.string().regex(/^[0-9]{4}-[0-9]{2}$/)), monthlyLimit: count,
  accountConsumed: count, sumUserConsumed: count, uniqueAcceptedDecisionUnits: count,
  decisionCount: count, uniqueDecisionCount: count,
  users: z.array(z.strictObject({ userId: z.uuid(), consumed: count, monthlyLimit: count, acceptedDecisionUnits: count }))
});
const verification = z.strictObject({
  passed: z.boolean(), errors: z.array(z.string()), accountConsumed: count, sumUserConsumed: count,
  uniqueAcceptedDecisionUnits: count, acceptedDecisions: count, rejectedDecisions: count,
  accounts: z.array(account)
});
const common = z.strictObject({
  schemaVersion: z.literal(1), runId: z.uuid(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  settings: z.strictObject({
    workload: z.enum(["throughput", "correctness"]), baseUrl: z.url(), accounts: count,
    usersPerAccount: count, concurrency: count, requests: count, timeoutMs: count, units: z.literal(1),
    accountMonthlyLimit: count, userMonthlyLimit: count, requestLimit: count,
    distribution: z.literal("round-robin accounts and users"), workloadModel: z.literal("closed-loop bounded workers")
  }),
  versions: z.strictObject({ runner: z.literal("1.0.0"), node: z.string(), undici: z.string().nullable(),
    application: z.string(), postgres: z.string().nullable() }),
  machine: z.strictObject({ platform: z.string(), arch: z.string(), osRelease: z.string(),
    logicalCpus: count, cpuModel: z.string(), memoryBytes: count }),
  source: z.strictObject({ commit: z.string().nullable(), dirty: z.boolean().nullable() })
});

export const loadResultSchema = z.discriminatedUnion("status", [
  common.extend({ status: z.literal("passed"), measurements,
    verification: verification.extend({ passed: z.literal(true), errors: z.array(z.string()).length(0) }),
    failure: z.null() }),
  common.extend({ status: z.literal("failed"), measurements: measurements.nullable(),
    verification: verification.nullable(), failure: z.strictObject({ stage: z.string(), message: z.string() }) })
]);

export async function writeLoadResult(path: string, value: unknown): Promise<void> {
  const report = loadResultSchema.parse(value);
  await mkdir(dirname(path), { recursive: true });
  // Results are evidence: never overwrite a previous run silently.
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
