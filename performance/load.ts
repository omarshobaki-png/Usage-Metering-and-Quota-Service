import { performance } from "node:perf_hooks";

import { consumptionDecisionSchema } from "../src/modules/usage/contract.js";
import type { LoadOptions } from "./config.js";
import type { LoadAccount } from "./fixtures.js";

export interface LoadCounts {
  accepted: number;
  quotaRejected: number;
  unexpectedHttpStatus: number;
  timeout: number;
  networkError: number;
  invalidResponse: number;
}

export interface Measurements {
  attempted: number;
  completed: number;
  maxInFlight: number;
  elapsedMs: number;
  completedPerSecond: number;
  acceptedPerSecond: number;
  latencyMs: { sampleCount: number; p50: number | null; p95: number | null; p99: number | null };
  counts: LoadCounts;
  httpStatuses: Record<string, number>;
  retries: 0;
  latencyScope: string;
}

export function latencyPercentiles(samples: number[]): Measurements["latencyMs"] {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length === 0 ? null : sorted[Math.ceil(p * sorted.length) - 1]!;
  return { sampleCount: sorted.length, p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) };
}

export async function runLoad(
  options: LoadOptions, fixtures: LoadAccount[], runId: string
): Promise<Measurements> {
  if (fixtures.length !== options.accounts || fixtures.some((account) => account.userIds.length !== options.usersPerAccount)) {
    throw new Error("Fixture counts do not match the requested workload.");
  }
  const counts: LoadCounts = { accepted: 0, quotaRejected: 0, unexpectedHttpStatus: 0, timeout: 0, networkError: 0, invalidResponse: 0 };
  const httpStatuses: Record<string, number> = {};
  const latencies: number[] = [];
  let next = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const began = performance.now();

  async function worker(): Promise<void> {
    while (next < options.requests) {
      // Claim synchronously before awaiting; only this fixed worker pool dispatches.
      const index = next++;
      const account = fixtures[index % fixtures.length]!;
      const userId = account.userIds[Math.floor(index / fixtures.length) % account.userIds.length]!;
      const requestId = `${runId}:${index}`;
      const started = performance.now();
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const response = await fetch(`${options.baseUrl}/consume`, {
          method: "POST", redirect: "error",
          headers: { "x-api-key": account.apiKey, "content-type": "application/json" },
          body: JSON.stringify({ userId, units: 1, requestId }),
          signal: AbortSignal.timeout(options.timeoutMs)
        });
        const status = String(response.status);
        httpStatuses[status] = (httpStatuses[status] ?? 0) + 1;
        // Include consuming the entire body in the attempt's latency/timeout.
        const text = await response.text();
        if (response.status !== 200) {
          counts.unexpectedHttpStatus += 1;
          continue;
        }
        let payload: unknown;
        try { payload = JSON.parse(text); } catch {
          counts.invalidResponse += 1;
          continue;
        }
        const parsed = consumptionDecisionSchema.safeParse(payload);
        if (!parsed.success || parsed.data.requestId !== requestId || parsed.data.userId !== userId || parsed.data.units !== 1) {
          counts.invalidResponse += 1;
          continue;
        }
        if (parsed.data.accepted) counts.accepted += 1;
        else counts.quotaRejected += 1;
      } catch (error) {
        if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) counts.timeout += 1;
        else counts.networkError += 1;
      } finally {
        latencies.push(performance.now() - started);
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, () => worker()));
  const elapsedMs = performance.now() - began;
  return {
    attempted: next, completed: latencies.length, maxInFlight, elapsedMs,
    completedPerSecond: elapsedMs > 0 ? latencies.length * 1000 / elapsedMs : 0,
    acceptedPerSecond: elapsedMs > 0 ? counts.accepted * 1000 / elapsedMs : 0,
    latencyMs: latencyPercentiles(latencies), counts, httpStatuses, retries: 0,
    latencyScope: "One HTTP attempt including response body; excludes queue wait, fixture setup and reconciliation. Includes failed attempts. No retries or redirects."
  };
}
