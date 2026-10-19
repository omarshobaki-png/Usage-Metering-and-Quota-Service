import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { createPool } from "../src/db/pool.js";
import { comparisonPlan, comparisonSettings, summarizeComparison, type Shape } from "./comparison.js";
import { loadResultSchema } from "./report.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const runFile = promisify(execFile);
const project = `quota-compare-${randomUUID()}`;
const expectedVolume = `${project}_postgres_data`;
const env = { ...process.env, RELIABILITY_API_IMAGE: `${project}-api` };
const composeArgs = ["compose", "-p", project, "-f", "compose.reliability.yaml"];
let attempted = false;
let completed = false;
let phase = "configuration";

async function command(file: string, args: string[], environment: NodeJS.ProcessEnv = env) {
  // Child failures are intentionally not dumped: environment/SQL errors can contain secrets.
  return (await runFile(file, args, { cwd: root, env: environment, timeout: 300000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
function compose(...args: string[]) { return command("docker", [...composeArgs, ...args]); }
async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}
async function port(service: string, target: string) {
  const published = await compose("port", service, target);
  assert(/^127\.0\.0\.1:\d+$/.test(published), "Expected one localhost port.");
  return published.split(":")[1]!;
}

if (process.argv.includes("--help")) {
  console.log("Usage: npm run perf:compare -- [--output-dir NEW_DIRECTORY]\nBuilds a disposable Docker stack; two 500-request warmups, then 18 fresh 2000-request runs. Never uses the development database. Keeps raw JSON and environment/summary JSON; removes only its own verified disposable volume on success.");
} else try {
  const { values } = parseArgs({ options: { "output-dir": { type: "string" } }, strict: true });
  const output = resolve(values["output-dir"] ?? `performance/results/account-comparison-${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(output, { recursive: false }); // Refuse an existing evidence directory.
  const startedAt = new Date().toISOString();
  console.log(`Performance comparison: ${project}\nEvidence: ${output}`);
  phase = "isolated Docker startup";
  attempted = true;
  await compose("up", "-d", "--build", "--wait", "--wait-timeout", "90");
  const origin = `http://127.0.0.1:${await port("api", "3000")}`;
  const databaseUrl = `postgres://quota_reliability:reliability-local-only@127.0.0.1:${await port("db", "5432")}/quota_reliability`;
  const childEnv = { ...env, DATABASE_URL: databaseUrl, API_KEY_PEPPER: "reliability-local-only-pepper" };
  const ids = (await compose("ps", "-q", "api", "db")).split(/\s+/);
  assert.equal(ids.length, 2);
  const containers = JSON.parse(await command("docker", ["inspect", ...ids])) as {
    Id: string; Image: string; Config: { Image: string; Labels: Record<string, string> };
    HostConfig: { NanoCpus: number; Memory: number; CpuQuota: number; CpuPeriod: number; CpusetCpus: string };
  }[];
  for (const container of containers) assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  const info = JSON.parse(await command("docker", ["info", "--format", "{{json .}}"]));
  const pool = createPool(databaseUrl);
  let postgres: unknown;
  try {
    postgres = (await pool.query("SELECT version() AS version, current_setting('max_connections') AS max_connections, current_setting('shared_buffers') AS shared_buffers, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit")).rows[0];
  } finally { await pool.end(); }
  const apiRuntime = JSON.parse(await compose("exec", "-T", "api", "node", "-e",
    "const {Pool}=require('pg'); console.log(JSON.stringify({node:process.version,pg:require('pg/package.json').version,poolMax:new Pool().options.max,processCount:1,entrypoint:'node dist/src/server.js'}))"));
  await writeJson(join(output, "environment.json"), {
    schemaVersion: 1, startedAt, project,
    source: { commit: await command("git", ["rev-parse", "HEAD"]), dirty: (await command("git", ["status", "--porcelain"])) !== "" },
    composeVersion: await command("docker", ["compose", "version", "--short"]),
    docker: { version: info.ServerVersion, operatingSystem: info.OperatingSystem, kernel: info.KernelVersion, architecture: info.Architecture, cpus: info.NCPU, memoryBytes: info.MemTotal },
    containers: containers.map((container) => ({ service: container.Config.Labels["com.docker.compose.service"], image: container.Config.Image, imageId: container.Image,
      resources: { nanoCpus: container.HostConfig.NanoCpus, memoryBytes: container.HostConfig.Memory,
        cpuQuota: container.HostConfig.CpuQuota, cpuPeriod: container.HostConfig.CpuPeriod, cpusetCpus: container.HostConfig.CpusetCpus } })),
    postgres, apiRuntime, clientAndServerShareMachine: true,
    developmentStackAlsoRunning: true,
    settings: comparisonSettings, concurrency: [1, 10, 50], warmups: { requestsPerShape: 500, concurrency: 10, separateFreshFixtures: true },
    notes: ["No CPU/memory limits in test Compose; zero resource values mean no explicit container cap.", "API and DB share Docker Desktop/WSL resources with the host-side generator and idle development stack.", "No lock-wait or pool-wait instrumentation; bottleneck explanations are inferences, not measured wait times."]
  });
  async function load(shape: Shape, concurrency: number, requests: number, file: string) {
    const args = ["--import", "tsx", "performance/run.ts", "--base-url", origin,
      "--accounts", shape === "hot" ? "1" : "10", "--users-per-account", shape === "hot" ? "20" : "2",
      "--requests", String(requests), "--monthly-limit", "4000", "--concurrency", String(concurrency), "--output", join(output, file)];
    await command(process.execPath, args, childEnv);
    const result = loadResultSchema.parse(JSON.parse(await readFile(join(output, file), "utf8")));
    assert(result.status === "passed");
    console.log(`PASS ${file}: ${result.measurements.acceptedPerSecond.toFixed(2)} req/s, p95 ${result.measurements.latencyMs.p95!.toFixed(2)} ms; totals ${result.verification.accountConsumed}/${result.verification.sumUserConsumed}/${result.verification.uniqueAcceptedDecisionUnits}`);
    return result;
  }
  phase = "separate warmup fixtures";
  const warmups = [];
  for (const shape of ["hot", "many"] as const) warmups.push(await load(shape, 10, 500, `warmup-${shape}.json`));
  const entries = [];
  for (const scenario of comparisonPlan()) {
    phase = scenario.file;
    entries.push({ scenario, result: await load(scenario.shape, scenario.concurrency, comparisonSettings.requests, scenario.file) });
  }
  phase = "comparison validation and secret scan";
  const summary = summarizeComparison(entries);
  const measuredAccounts = new Set(entries.flatMap((entry) => entry.result.verification.accounts.map((account) => account.accountId)));
  for (const warmup of warmups) for (const account of warmup.verification.accounts) assert(!measuredAccounts.has(account.accountId));
  const serialized = JSON.stringify(entries);
  const logs = await compose("logs", "--no-color", "api");
  for (const text of [serialized, logs]) {
    assert(!/umq_[A-Za-z0-9_-]{40,}/.test(text), "API key leak.");
    assert(!text.includes("reliability-local-only-pepper"), "Pepper leak.");
    assert(!/postgres(?:ql)?:\/\//.test(text), "Connection URL leak.");
  }
  await writeJson(join(output, "summary.json"), { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
    status: "passed", measuredRuns: entries.length, warmupRuns: warmups.length, acceptedMeasuredUnits: 36000,
    aggregation: "Median of three run-level metrics; min/max are run-level spreads, not pooled percentiles.", summary });
  console.table(summary.map((row) => ({ shape: row.shape, concurrency: row.concurrency, medianRps: row.requestsPerSecond.median.toFixed(2), medianP95: row.p95Ms.median.toFixed(2) })));
  completed = true;
  console.log("PASS all eighteen runs reconciled; raw JSON, environment and summary saved.");
} catch {
  console.error(`FAIL performance comparison during ${phase}; no successful comparison claimed. Existing raw evidence and diagnostic test volume are retained. Private child output omitted.`);
  process.exitCode = 1;
} finally {
  if (attempted) try {
    await compose("down", "--remove-orphans");
    if (completed) {
      const volume = JSON.parse(await command("docker", ["volume", "inspect", expectedVolume])) as { Name: string; Labels: Record<string, string> }[];
      assert.equal(volume.length, 1);
      assert.equal(volume[0]!.Name, expectedVolume);
      assert.equal(volume[0]!.Labels["com.docker.compose.project"], project);
      assert.equal(volume[0]!.Labels["com.docker.compose.volume"], "postgres_data");
      await command("docker", ["volume", "rm", expectedVolume]);
      console.log("PASS removed only the ownership-verified disposable containers/network/volume; development stack unchanged.");
    } else console.error(`Disposable diagnostic volume retained: ${expectedVolume}`);
  } catch {
    console.error(`Cleanup requires attention for ${project}; no development resources targeted.`);
    process.exitCode = 1;
  }
}
