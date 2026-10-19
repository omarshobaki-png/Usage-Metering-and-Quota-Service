import { describe, expect, it } from "vitest";

import { observeWork, summarizeLocks, type LockCounts } from "../../performance/lock-sampling.js";

const zero: LockCounts = { backends: 10, active: 1, lockWaiting: 0, accountLockWaiting: 0, lockEvents: {} };

describe("diagnostic PostgreSQL lock sample semantics", () => {
  it("summarizes concurrent backend observations without presenting them as durations", () => {
    const result = summarizeLocks([
      { ...zero, elapsedMs: 1 },
      { backends: 10, active: 10, lockWaiting: 9, accountLockWaiting: 8, lockEvents: { transactionid: 7, tuple: 2 }, elapsedMs: 27 }
    ]);
    expect(result).toMatchObject({ sampleCount: 2, samplesWithAccountLockWait: 1, fractionWithAccountLockWait: 0.5,
      meanBackends: 10, meanActive: 5.5, meanLockWaiting: 4.5, meanAccountLockWaiting: 4, peakAccountLockWaiting: 8,
      lockEventObservations: { transactionid: 7, tuple: 2 } });
    expect(result).not.toHaveProperty("waitMilliseconds");
  });
  it("rejects absent samples and impossible sample counts/times", () => {
    expect(() => summarizeLocks([])).toThrow();
    expect(() => summarizeLocks([{ ...zero, elapsedMs: -1 }])).toThrow();
    expect(() => summarizeLocks([{ ...zero, accountLockWaiting: 1, elapsedMs: 1 }])).toThrow();
    expect(() => summarizeLocks([{ ...zero, lockEvents: { tuple: 1 }, elapsedMs: 1 }])).toThrow();
  });
  it("propagates sampling failures after draining the workload", async () => {
    let drained = false;
    await expect(observeWork(async () => { throw new Error("private observer error"); }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5)); drained = true;
    }, 1)).rejects.toThrow("Lock observation failed");
    expect(drained).toBe(true);
  });
  it("drains polling on work failure and rejects invalid intervals", async () => {
    let sampled = false;
    await expect(observeWork(async () => { sampled = true; return zero; }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("work failed");
    }, 1)).rejects.toThrow("work failed");
    expect(sampled).toBe(true);
    await expect(observeWork(async () => zero, async () => 1, 0)).rejects.toThrow("Invalid observation interval");
  });
});
