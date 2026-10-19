import assert from "node:assert/strict";

import { z } from "zod";

import { loadResultSchema } from "./report.js";

export const comparisonSettings = { requests: 2000, monthlyLimit: 4000, totalUsers: 20, repetitions: 3 } as const;
export type Shape = "hot" | "many";
export interface ComparisonScenario { shape: Shape; concurrency: number; repetition: number; file: string }

export function comparisonPlan(): ComparisonScenario[] {
  const scenarios: ComparisonScenario[] = [];
  // Alternate shape order and rotate concurrency order to reduce fixed-order bias.
  for (const [index, levels] of [[1, 10, 50], [50, 10, 1], [10, 50, 1]].entries()) {
    for (const concurrency of levels) for (const shape of (index === 1 ? ["many", "hot"] : ["hot", "many"]) as Shape[]) {
      const repetition = index + 1;
      scenarios.push({ shape, concurrency, repetition, file: `${shape}-c${concurrency}-r${repetition}.json` });
    }
  }
  return scenarios;
}

export function median(values: number[]): number {
  assert(values.length > 0 && values.every(Number.isFinite), "Expected finite samples.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

type Result = z.infer<typeof loadResultSchema>;
export function summarizeComparison(entries: { scenario: ComparisonScenario; result: unknown }[]) {
  const plan = comparisonPlan();
  assert.equal(entries.length, plan.length, "All eighteen measurements are required.");
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>();
  const seenAccounts = new Set<string>();
  let reference: string | undefined;
  const validated = entries.map(({ scenario, result: input }) => {
    assert(plan.some((item) => JSON.stringify(item) === JSON.stringify(scenario)), "Unknown scenario.");
    assert(!seenFiles.has(scenario.file), "Duplicate scenario.");
    seenFiles.add(scenario.file);
    const result: Result = loadResultSchema.parse(input);
    assert(result.status === "passed", "Failed runs cannot become benchmark evidence.");
    assert(!seenIds.has(result.runId), "Each measurement needs a fresh run ID.");
    seenIds.add(result.runId);
    const accounts = scenario.shape === "hot" ? 1 : 10;
    const settings = result.settings;
    assert.equal(settings.workload, "throughput");
    assert.equal(settings.accounts, accounts);
    assert.equal(settings.usersPerAccount * accounts, comparisonSettings.totalUsers);
    assert.equal(settings.requests, comparisonSettings.requests);
    assert.equal(settings.concurrency, scenario.concurrency);
    assert.equal(settings.accountMonthlyLimit, comparisonSettings.monthlyLimit);
    assert.equal(settings.userMonthlyLimit, comparisonSettings.monthlyLimit);
    assert.equal(settings.requestLimit, comparisonSettings.requests);
    assert.equal(settings.timeoutMs, 10000);
    const context = JSON.stringify({ versions: result.versions, source: result.source, machine: result.machine, origin: settings.baseUrl });
    reference ??= context;
    assert.equal(context, reference, "Runtime/source/machine must be comparable.");
    const measured = result.measurements;
    const verified = result.verification;
    assert.equal(measured.completed, comparisonSettings.requests);
    assert.equal(measured.attempted, comparisonSettings.requests);
    assert.equal(measured.counts.accepted, comparisonSettings.requests);
    assert.equal(Object.values(measured.counts).reduce((a, b) => a + b, 0), comparisonSettings.requests);
    assert.equal(measured.maxInFlight, scenario.concurrency);
    assert.equal(measured.latencyMs.sampleCount, comparisonSettings.requests);
    assert.equal(verified.accountConsumed, comparisonSettings.requests);
    assert.equal(verified.sumUserConsumed, comparisonSettings.requests);
    assert.equal(verified.uniqueAcceptedDecisionUnits, comparisonSettings.requests);
    assert.equal(verified.acceptedDecisions, comparisonSettings.requests);
    assert.equal(verified.rejectedDecisions, 0);
    assert.equal(verified.accounts.length, accounts);
    for (const account of verified.accounts) {
      assert(!seenAccounts.has(account.accountId), "Fixture accounts must not be reused.");
      seenAccounts.add(account.accountId);
      assert.equal(account.accountConsumed, comparisonSettings.requests / accounts);
      assert.equal(account.sumUserConsumed, account.accountConsumed);
      assert.equal(account.uniqueAcceptedDecisionUnits, account.accountConsumed);
      assert.equal(account.decisionCount, account.accountConsumed);
      assert.equal(account.uniqueDecisionCount, account.accountConsumed);
      assert.equal(account.monthlyLimit, comparisonSettings.monthlyLimit);
      assert.equal(account.users.length, comparisonSettings.totalUsers / accounts);
      for (const user of account.users) {
        assert.equal(user.consumed, comparisonSettings.requests / comparisonSettings.totalUsers);
        assert.equal(user.acceptedDecisionUnits, user.consumed);
      }
    }
    return { scenario, measured };
  });
  return (["hot", "many"] as const).flatMap((shape) => [1, 10, 50].map((concurrency) => {
    const group = validated.filter((entry) => entry.scenario.shape === shape && entry.scenario.concurrency === concurrency);
    assert.equal(group.length, comparisonSettings.repetitions);
    const spread = (values: number[]) => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) });
    return { shape, concurrency, repetitions: group.length, files: group.map((entry) => entry.scenario.file),
      requestsPerSecond: spread(group.map((entry) => entry.measured.acceptedPerSecond)),
      elapsedMs: spread(group.map((entry) => entry.measured.elapsedMs)),
      p50Ms: spread(group.map((entry) => entry.measured.latencyMs.p50!)),
      p95Ms: spread(group.map((entry) => entry.measured.latencyMs.p95!)),
      p99Ms: spread(group.map((entry) => entry.measured.latencyMs.p99!)) };
  }));
}
