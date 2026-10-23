import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DemoApiClient } from "../../demo/client.js";
import { parseLoadOptions } from "../../performance/config.js";
import { createLoadFixtures } from "../../performance/fixtures.js";
import { runLoad } from "../../performance/load.js";
import { reconcileLoad } from "../../performance/reconcile.js";
import { loadResultSchema } from "../../performance/report.js";
import { buildApp } from "../../src/app.js";
import { createAppOperations } from "../../src/app-operations.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("A PostgreSQL URL is required for load-runner integration tests.");
const schema = `load_runner_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: databaseUrl, max: 1 });
const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema} -c statement_timeout=5000` });
const pepper = "load-runner-integration-pepper";
let app: FastifyInstance | undefined;
let origin: string;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
  app = buildApp({
    ...createAppOperations(pool, pepper, { clock: () => new Date("2026-10-18T08:00:00.000Z") }),
    logger: false
  });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app?.close();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
});

async function setup(extra: string[] = []) {
  const options = parseLoadOptions(["--base-url", origin, "--requests", "20", "--concurrency", "2", ...extra], {});
  const runId = randomUUID();
  const fixtures = await createLoadFixtures(pool, options, pepper, runId);
  return { options, runId, fixtures };
}

describe("real HTTP load and independent PostgreSQL reconciliation", () => {
  it("accepts twenty throughput actions and reconciles separate accounts/users", async () => {
    const { options, runId, fixtures } = await setup(["--accounts", "2", "--monthly-limit", "40"]);
    expect(fixtures.every((fixture) => fixture.monthlyLimit === 40 && fixture.userMonthlyLimit === 40)).toBe(true);
    const measured = await runLoad(options, fixtures, runId);
    const verified = await reconcileLoad(pool, fixtures, options, runId, measured);
    expect(measured.counts.accepted).toBe(20);
    expect(measured.maxInFlight).toBeLessThanOrEqual(2);
    expect(verified).toMatchObject({ passed: true, errors: [], accountConsumed: 20, sumUserConsumed: 20, uniqueAcceptedDecisionUnits: 20 });
    expect(verified.accounts.map((account) => account.accountConsumed)).toEqual([10, 10]);
    expect(verified.accounts.flatMap((account) => account.users.map((user) => user.consumed))).toEqual([5, 5, 5, 5]);
    expect(JSON.stringify(verified)).not.toContain(fixtures[0]!.apiKey);
  });

  it("accepts exactly 100 and rejects 100 unique concurrent requests sharing allowance 100", async () => {
    const { options, runId, fixtures } = await setup(["--workload", "correctness", "--requests", "200", "--concurrency", "20"]);
    const measured = await runLoad(options, fixtures, runId);
    expect(measured.counts).toEqual({ accepted: 100, quotaRejected: 100, unexpectedHttpStatus: 0, timeout: 0, networkError: 0, invalidResponse: 0 });
    const verified = await reconcileLoad(pool, fixtures, options, runId, measured);
    expect(verified).toMatchObject({ passed: true, errors: [], accountConsumed: 100, sumUserConsumed: 100, uniqueAcceptedDecisionUnits: 100,
      acceptedDecisions: 100, rejectedDecisions: 100 });
    expect(verified.accounts[0]).toMatchObject({ decisionCount: 200, uniqueDecisionCount: 200, months: ["2026-10"] });
  });

  it("detects an overspent counter even when every HTTP response looked successful", async () => {
    const { options, runId, fixtures } = await setup();
    const measured = await runLoad(options, fixtures, runId);
    await pool.query("UPDATE account_monthly_usage SET consumed_units = consumed_units + 1 WHERE account_id = $1", [fixtures[0]!.id]);
    const verified = await reconcileLoad(pool, fixtures, options, runId, measured);
    expect(measured.counts.accepted).toBe(20);
    expect(verified.passed).toBe(false);
    expect(verified.errors.some((error) => error.startsWith("monthly_totals:"))).toBe(true);
    expect(verified.errors.some((error) => error.startsWith("account_no_overspend:"))).toBe(true);
  });

  it("does not pass a throughput run whose fixture was changed to reject all work", async () => {
    const { options, runId, fixtures } = await setup();
    const fixture = fixtures[0]!;
    await new DemoApiClient({ serviceUrl: origin, apiKey: fixture.apiKey }).updatePlan(fixture.accountPlanId, { monthlyLimit: 0 });
    const measured = await runLoad(options, fixtures, runId);
    const verified = await reconcileLoad(pool, fixtures, options, runId, measured);
    expect(measured.counts.quotaRejected).toBe(20);
    expect(verified.passed).toBe(false);
    expect(verified.errors).toContain("expected_workload_outcome");
    expect(verified.errors.some((error) => error.startsWith("fixed_account_plan:"))).toBe(true);
  });

  it("writes a failed machine-readable CLI result for an unreachable API and exits 1", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const directory = await mkdtemp(join(tmpdir(), "quota-load-result-"));
    const output = join(directory, "unreachable.json");
    try {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "performance/run.ts",
        "--base-url", `http://127.0.0.1:${address.port}`, "--requests", "20", "--output", output
      ], { env: { ...process.env, DATABASE_URL: databaseUrl, API_KEY_PEPPER: pepper }, timeout: 15_000 })
        .then(() => { throw new Error("CLI unexpectedly succeeded."); }, (error: { code: number; stdout: string; stderr: string }) => error);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("FAIL throughput load run");
      expect(result.stdout + result.stderr).not.toContain(pepper);
      const report = loadResultSchema.parse(JSON.parse(await readFile(output, "utf8")));
      expect(report.status).toBe("failed");
      expect(report.measurements).toBeNull();
      expect(report.verification).toBeNull();
      expect(report.failure?.stage).toBe("API readiness");
      expect(JSON.stringify(report)).not.toContain(pepper);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
