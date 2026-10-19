import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { Pool } from "pg";

import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { loadHelp, parseLoadOptions } from "./config.js";
import { createLoadFixtures } from "./fixtures.js";
import { runLoad, type Measurements } from "./load.js";
import { reconcileLoad, type Reconciliation } from "./reconcile.js";
import { writeLoadResult } from "./report.js";

const runFile = promisify(execFile);

async function main(): Promise<void> {
  const options = parseLoadOptions(process.argv.slice(2));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const output = options.output ?? resolve("performance/results", `${startedAt.replaceAll(":", "-")}-${options.workload}-${runId}.json`);
  try {
    await access(output);
    throw new Error("Choose a new result path; this result already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const application = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { version: string };
  let commit: string | null = null;
  let dirty: boolean | null = null;
  try {
    commit = (await runFile("git", ["rev-parse", "HEAD"])).stdout.trim();
    dirty = (await runFile("git", ["status", "--porcelain"])).stdout.trim() !== "";
  } catch { /* Source metadata is unavailable outside a Git checkout. */ }
  const versions = { runner: "1.0.0", node: process.version, undici: process.versions.undici ?? null,
    application: application.version, postgres: null as string | null };
  let pool: Pool | undefined;
  let measured: Measurements | null = null;
  let verification: Reconciliation | null = null;
  let failure: { stage: string; message: string } | null = null;
  let stage = "configuration";

  console.log(`Load run ${runId}: ${options.workload}, ${options.requests} requests, ${options.concurrency} workers, ${options.accounts} account(s).`);
  try {
    const config = loadConfig();
    stage = "API readiness";
    const health = await fetch(`${options.baseUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs) });
    if (!health.ok) throw new Error("API health check failed.");
    await health.arrayBuffer();
    stage = "fixture setup";
    pool = createPool(config.DATABASE_URL);
    versions.postgres = (await pool.query<{ server_version: string }>("SHOW server_version")).rows[0]!.server_version;
    const fixtures = await createLoadFixtures(pool, options, config.API_KEY_PEPPER, runId);
    console.log(`Prepared ${fixtures.length} fresh account(s) with ${options.usersPerAccount} user(s) each; API keys kept in memory.`);
    stage = "HTTP workload";
    measured = await runLoad(options, fixtures, runId);
    stage = "reconciliation";
    verification = await reconcileLoad(pool, fixtures, options, runId, measured);
    if (!verification.passed) failure = { stage, message: "Workload or accounting checks failed; inspect verification.errors." };
  } catch {
    // Never print raw transport/SQL errors, connection URLs, keys, or peppers.
    failure = { stage, message: "Run failed. Check API/database connectivity, matching pepper, and fixture permissions. No benchmark requests were retried." };
  } finally {
    try { await pool?.end(); } catch {
      failure = { stage: "database cleanup", message: "Could not close the verification connection pool." };
    }
  }

  const { output: _output, monthlyLimit: _monthlyLimit, ...settings } = options;
  const cpu = cpus();
  const report = {
    schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(),
    status: failure === null ? "passed" : "failed",
    settings: { ...settings, units: 1, accountMonthlyLimit: options.workload === "correctness" ? 100 : (options.monthlyLimit ?? options.requests),
      userMonthlyLimit: options.monthlyLimit ?? options.requests, requestLimit: options.requests,
      distribution: "round-robin accounts and users", workloadModel: "closed-loop bounded workers" },
    versions, source: { commit, dirty },
    machine: { platform: platform(), arch: arch(), osRelease: release(), logicalCpus: cpu.length,
      cpuModel: cpu[0]?.model ?? "unknown", memoryBytes: totalmem() },
    measurements: measured, verification, failure
  };
  await writeLoadResult(output, report);
  console.log(`${report.status === "passed" ? "PASS" : "FAIL"} ${options.workload} load run`);
  if (measured !== null) {
    console.log(`Completed ${measured.completed}/${options.requests} in ${measured.elapsedMs.toFixed(2)} ms; ${measured.completedPerSecond.toFixed(2)} completed/s; ${measured.acceptedPerSecond.toFixed(2)} accepted/s.`);
    console.log(`Counts: ${JSON.stringify(measured.counts)}`);
    console.log(`Latency ms (one attempt, no retries): p50=${measured.latencyMs.p50?.toFixed(2)} p95=${measured.latencyMs.p95?.toFixed(2)} p99=${measured.latencyMs.p99?.toFixed(2)}`);
  }
  if (verification !== null) {
    console.log(`Stored totals: account=${verification.accountConsumed}; users=${verification.sumUserConsumed}; unique accepted units=${verification.uniqueAcceptedDecisionUnits}.`);
    if (!verification.passed) console.log(`Failed checks: ${verification.errors.join(", ")}`);
  }
  if (failure !== null) console.error(`Failure at ${failure.stage}: ${failure.message}`);
  console.log(`Result: ${output}`);
  if (failure !== null) process.exitCode = 1;
}

if (process.argv.slice(2).includes("--help")) console.log(loadHelp);
else {
  try { await main(); } catch {
    console.error("FAIL load runner configuration/result output. Use --help, provide valid options, and choose a new writable JSON result path.");
    process.exitCode = 1;
  }
}
