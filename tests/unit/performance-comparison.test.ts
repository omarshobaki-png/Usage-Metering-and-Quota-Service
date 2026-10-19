import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { comparisonPlan, median, summarizeComparison } from "../../performance/comparison.js";
import { loadResultSchema } from "../../performance/report.js";

// A schema-valid base, then synthetic data solely for aggregation tests, never saved as evidence.
const base = loadResultSchema.parse(JSON.parse(await readFile("performance/results/runner-smoke.json", "utf8")));
if (base.status !== "passed") throw new Error("Expected the known runner validation result.");
function entries() {
  return comparisonPlan().map((scenario) => {
    const result = structuredClone(base);
    if (result.status !== "passed") throw new Error("Expected a passed synthetic test base.");
    result.runId = randomUUID();
    const accounts = scenario.shape === "hot" ? 1 : 10;
    Object.assign(result.settings, { accounts, usersPerAccount: 20 / accounts, concurrency: scenario.concurrency,
      requests: 2000, accountMonthlyLimit: 4000, userMonthlyLimit: 4000, requestLimit: 2000 });
    Object.assign(result.measurements, { attempted: 2000, completed: 2000, maxInFlight: scenario.concurrency,
      acceptedPerSecond: [100, 300, 200][scenario.repetition - 1], completedPerSecond: [100, 300, 200][scenario.repetition - 1] });
    result.measurements.counts.accepted = 2000;
    result.measurements.latencyMs.sampleCount = 2000;
    Object.assign(result.verification, { accountConsumed: 2000, sumUserConsumed: 2000, uniqueAcceptedDecisionUnits: 2000, acceptedDecisions: 2000 });
    result.verification.accounts = Array.from({ length: accounts }, () => ({ accountId: randomUUID(), months: ["2026-10"], monthlyLimit: 4000,
      accountConsumed: 2000 / accounts, sumUserConsumed: 2000 / accounts, uniqueAcceptedDecisionUnits: 2000 / accounts,
      decisionCount: 2000 / accounts, uniqueDecisionCount: 2000 / accounts,
      users: Array.from({ length: 20 / accounts }, () => ({ userId: randomUUID(), consumed: 100, monthlyLimit: 4000, acceptedDecisionUnits: 100 })) }));
    return { scenario, result };
  });
}

describe("comparison evidence validation", () => {
  it("uses eighteen distinct scenarios with equal total users and counterbalanced order", () => {
    const plan = comparisonPlan();
    expect(plan).toHaveLength(18);
    expect(new Set(plan.map((scenario) => scenario.file)).size).toBe(18);
    expect(plan[0]?.shape).toBe("hot");
    expect(plan[6]?.shape).toBe("many");
  });
  it("calculates median without mutating samples, including even-length lists", () => {
    const sample = [300, 100, 200];
    expect(median(sample)).toBe(200);
    expect(sample).toEqual([300, 100, 200]);
    expect(median([1, 3])).toBe(2);
    expect(() => median([])).toThrow();
  });
  it("summarizes three actual run-level metrics per group, not a median of all groups", () => {
    const summary = summarizeComparison(entries());
    expect(summary).toHaveLength(6);
    expect(summary.every((row) => row.repetitions === 3 && row.requestsPerSecond.median === 200 && row.requestsPerSecond.min === 100 && row.requestsPerSecond.max === 300)).toBe(true);
  });
  it("refuses missing or duplicate runs", () => {
    expect(() => summarizeComparison(entries().slice(1))).toThrow();
    const data = entries();
    data[1] = data[0]!;
    expect(() => summarizeComparison(data)).toThrow();
  });
  it("refuses reused fixtures, unequal workloads, and unreconciled totals", () => {
    for (const corrupt of [
      (data: ReturnType<typeof entries>) => { data[1]!.result.verification.accounts[0]!.accountId = data[0]!.result.verification.accounts[0]!.accountId; },
      (data: ReturnType<typeof entries>) => { data[0]!.result.settings.usersPerAccount = 2; },
      (data: ReturnType<typeof entries>) => { data[0]!.result.verification.accountConsumed = 1999; },
      (data: ReturnType<typeof entries>) => { data[0]!.result.measurements.counts.timeout = 1; },
      (data: ReturnType<typeof entries>) => { data[0]!.result.source.commit = "different"; }
    ]) {
      const data = entries(); corrupt(data);
      expect(() => summarizeComparison(data)).toThrow();
    }
  });
});
