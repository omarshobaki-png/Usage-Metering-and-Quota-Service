import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseLoadOptions } from "../../performance/config.js";
import type { LoadAccount } from "../../performance/fixtures.js";
import { latencyPercentiles, runLoad } from "../../performance/load.js";
import { loadResultSchema } from "../../performance/report.js";

const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test listener did not bind TCP.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  }
});

function fixture(accounts = 1): LoadAccount[] {
  return Array.from({ length: accounts }, () => ({ id: randomUUID(), apiKey: `umq_${"a".repeat(43)}`,
    accountPlanId: 1, userPlanId: 3, monthlyLimit: 1000, userMonthlyLimit: 1000,
    requestLimit: 1000, userIds: [randomUUID(), randomUUID()] }));
}

describe("load configuration and latency math", () => {
  it("keeps the machine-readable JSON Schema aligned with the emitted result validator", async () => {
    const saved = JSON.parse(await readFile("performance/result.schema.json", "utf8"));
    expect(saved).toEqual({ ...z.toJSONSchema(loadResultSchema), $id: "urn:usage-metering:load-result:v1" });
  });
  it("selects explicit fixed workloads and validates a credential-free HTTP origin", () => {
    expect(parseLoadOptions(["--requests", "20", "--concurrency", "2"], {})).toMatchObject({
      workload: "throughput", baseUrl: "http://127.0.0.1:3000", accounts: 1, requests: 20, concurrency: 2
    });
    expect(parseLoadOptions(["--workload", "correctness"], {})).toMatchObject({ accounts: 1, requests: 200 });
    expect(() => parseLoadOptions(["--base-url", "https://secret@example.test/?key=private"], {})).toThrow();
  });

  it.each([
    ["--concurrency", "0"], ["--requests", "2.5"], ["--requests", "100001"],
    ["--accounts", "3", "--requests", "2"], ["--timeout-ms", "-1"],
    ["--workload", "correctness", "--requests", "20"],
    ["--workload", "correctness", "--accounts", "2"],
    ["--monthly-limit", "10", "--requests", "20"], ["--monthly-limit", "0"],
    ["--workload", "correctness", "--monthly-limit", "4000"]
  ])("rejects invalid settings %j", (...args) => {
    expect(() => parseLoadOptions(args, {})).toThrow();
  });

  it("allows explicit throughput headroom without changing default or correctness fixtures", () => {
    expect(parseLoadOptions(["--requests", "2000", "--monthly-limit", "4000"], {})).toMatchObject({ requests: 2000, monthlyLimit: 4000 });
    expect(parseLoadOptions([], {}).monthlyLimit).toBeUndefined();
  });

  it("uses nearest-rank percentiles and leaves the original samples unchanged", () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(latencyPercentiles(values)).toEqual({ sampleCount: 100, p50: 50, p95: 95, p99: 99 });
    expect(values[0]).toBe(100);
    expect(latencyPercentiles([])).toEqual({ sampleCount: 0, p50: null, p95: null, p99: null });
  });
});

describe("bounded HTTP load workers", () => {
  it("sends exactly twenty unique actions with no more than two in flight", async () => {
    let active = 0;
    let peak = 0;
    const actions: { userId: string; units: number; requestId: string }[] = [];
    const origin = await listen((request, response) => {
      void (async () => {
        active += 1;
        peak = Math.max(peak, active);
        let text = "";
        for await (const chunk of request) text += String(chunk);
        const action = JSON.parse(text) as typeof actions[number];
        actions.push(action);
        await new Promise((resolve) => setTimeout(resolve, 5));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ...action, accepted: true, blockedBy: null,
          processedAt: "2026-10-18T08:00:00.000Z", month: "2026-10",
          account: { consumed: 1, remaining: 999, plan: { id: 1, revision: 1 } },
          user: { consumed: 1, remaining: 999, plan: { id: 3, revision: 1 } }
        }));
        active -= 1;
      })().catch(() => { response.statusCode = 500; response.end(); });
    });
    const options = parseLoadOptions(["--base-url", origin, "--requests", "20", "--concurrency", "2", "--accounts", "2"], {});
    const accounts = fixture(2);
    const measured = await runLoad(options, accounts, randomUUID());
    expect(measured.counts).toEqual({ accepted: 20, quotaRejected: 0, unexpectedHttpStatus: 0, timeout: 0, networkError: 0, invalidResponse: 0 });
    expect(measured.completed).toBe(20);
    expect(measured.latencyMs.sampleCount).toBe(20);
    expect(measured.maxInFlight).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(new Set(actions.map((action) => action.requestId)).size).toBe(20);
    expect(actions.every((action) => action.units === 1)).toBe(true);
    for (const account of accounts) for (const userId of account.userIds) {
      expect(actions.filter((action) => action.userId === userId)).toHaveLength(5);
    }
    expect(measured.completedPerSecond).toBeCloseTo(20_000 / measured.elapsedMs, 8);
    expect(JSON.stringify(measured)).not.toContain(accounts[0]!.apiKey);
  });

  it("counts unexpected HTTP statuses without retrying or saving response secrets", async () => {
    let attempts = 0;
    const secret = `umq_${"z".repeat(43)}`;
    const origin = await listen((_request, response) => {
      attempts += 1; response.statusCode = 503; response.end(secret);
    });
    const result = await runLoad(parseLoadOptions(["--base-url", origin, "--requests", "3"], {}), fixture(), randomUUID());
    expect(attempts).toBe(3);
    expect(result.counts.unexpectedHttpStatus).toBe(3);
    expect(result.httpStatuses).toEqual({ "503": 3 });
    expect(result.retries).toBe(0);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("classifies invalid successful responses separately", async () => {
    const origin = await listen((_request, response) => { response.end('{"accepted":true}'); });
    const result = await runLoad(parseLoadOptions(["--base-url", origin, "--requests", "2"], {}), fixture(), randomUUID());
    expect(result.counts.invalidResponse).toBe(2);
    expect(result.counts.accepted).toBe(0);
  });

  it("counts timeouts as failed attempts without retries", async () => {
    const origin = await listen((_request, response) => { setTimeout(() => response.end("{}"), 150).unref(); });
    const result = await runLoad(parseLoadOptions(["--base-url", origin, "--requests", "2", "--timeout-ms", "20"], {}), fixture(), randomUUID());
    expect(result.counts.timeout).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.retries).toBe(0);
  });

  it("reports an unreachable server as network failures, never accepted work", async () => {
    const origin = await listen((_request, response) => response.end());
    await new Promise<void>((resolve) => servers[0]!.close(() => resolve()));
    const result = await runLoad(parseLoadOptions(["--base-url", origin, "--requests", "3"], {}), fixture(), randomUUID());
    expect(result.counts.networkError).toBe(3);
    expect(result.counts.accepted).toBe(0);
    expect(result.completed).toBe(3);
  });
});
