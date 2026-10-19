import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { Pool } from "pg";

import { parseLoadOptions } from "./config.js";
import { createLoadFixtures } from "./fixtures.js";
import { runLoad } from "./load.js";
import { observeWork, readLockCounts } from "./lock-sampling.js";
import { reconcileLoad } from "./reconcile.js";
import { writeLoadResult } from "./report.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const runFile = promisify(execFile);
const project = `quota-diagnose-${randomUUID()}`;
const volumeName = `${project}_postgres_data`;
const env = { ...process.env, RELIABILITY_API_IMAGE: `${project}-api` };
const composeArgs = ["compose", "-p", project, "-f", "compose.reliability.yaml"];
let attempted = false;
let completed = false;
let phase = "configuration";
let pool: Pool | undefined;
let observer: Pool | undefined;

async function command(file: string, args: string[]) {
  return (await runFile(file, args, { cwd: root, env, timeout: 300000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
}
function compose(...args: string[]) { return command("docker", [...composeArgs, ...args]); }
function writeJson(path: string, value: unknown) { return writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
async function port(service: string, target: string) {
  const published = await compose("port", service, target);
  assert(/^127\.0\.0\.1:\d+$/.test(published));
  return published.split(":")[1]!;
}

if (process.argv.includes("--help")) {
  console.log("Usage: npm run perf:diagnose -- [--output-dir NEW_DIRECTORY]\nIsolated Docker diagnostic: two separate warmups, six 2000-request loads at concurrency 10, API-only PostgreSQL lock samples every >=25 ms. Keeps raw results; deletes only its ownership-verified disposable volume on success. Not a replacement for uninstrumented benchmarks.");
} else try {
  const { values } = parseArgs({ strict: true, options: { "output-dir": { type: "string" } } });
  const output = resolve(values["output-dir"] ?? `performance/results/lock-diagnostics-${new Date().toISOString().replaceAll(":", "-")}`);
  await mkdir(output, { recursive: false });
  const startedAt = new Date().toISOString();
  console.log(`Lock diagnostics: ${project}\nEvidence: ${output}`);
  phase = "isolated stack startup";
  attempted = true;
  await compose("up", "-d", "--build", "--wait", "--wait-timeout", "90");
  const baseUrl = `http://127.0.0.1:${await port("api", "3000")}`;
  const connectionString = `postgres://quota_reliability:reliability-local-only@127.0.0.1:${await port("db", "5432")}/quota_reliability`;
  pool = new Pool({ connectionString, max: 2, application_name: "quota-diagnostic-fixtures", connectionTimeoutMillis: 2000 });
  observer = new Pool({ connectionString, max: 1, application_name: "quota-diagnostic-observer", connectionTimeoutMillis: 2000,
    options: "-c statement_timeout=2000" });
  const containers = JSON.parse(await command("docker", ["inspect", ...(await compose("ps", "-q", "api", "db")).split(/\s+/)])) as {
    Image: string; Config: { Image: string; Labels: Record<string, string> };
    HostConfig: { NanoCpus: number; Memory: number };
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  }[];
  assert.equal(containers.length, 2);
  for (const container of containers) assert.equal(container.Config.Labels["com.docker.compose.project"], project);
  const api = containers.find((container) => container.Config.Labels["com.docker.compose.service"] === "api")!;
  const address = Object.values(api.NetworkSettings.Networks);
  assert.equal(address.length, 1);
  const apiAddress = address[0]!.IPAddress;
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(apiAddress));
  const source = { commit: await command("git", ["rev-parse", "HEAD"]), dirty: (await command("git", ["status", "--porcelain"])) !== "" };
  const application = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
  const postgres = (await pool.query<{ version: string; serverVersion: string }>(
    "SELECT version() AS version, current_setting('server_version') AS \"serverVersion\"")).rows[0]!;
  const cpu = cpus();
  const machine = { platform: platform(), arch: arch(), osRelease: release(), logicalCpus: cpu.length,
    cpuModel: cpu[0]?.model ?? "unknown", memoryBytes: totalmem() };
  const versions = { runner: "1.0.0", node: process.version, undici: process.versions.undici ?? null,
    application: application.version, postgres: postgres.serverVersion };
  const apiRuntime = JSON.parse(await compose("exec", "-T", "api", "node", "-e",
    "const {Pool}=require('pg');const p=new Pool();console.log(JSON.stringify({node:process.version,poolMax:p.options.max,applicationName:p.options.application_name??'',processCount:1}))"));
  assert.equal(apiRuntime.applicationName, "");
  const docker = JSON.parse(await command("docker", ["info", "--format", "{{json .}}"]));
  await writeJson(join(output, "environment.json"), { schemaVersion: 1, startedAt, source, machine, versions,
    docker: { version: docker.ServerVersion, operatingSystem: docker.OperatingSystem, cpus: docker.NCPU, memoryBytes: docker.MemTotal },
    composeVersion: await command("docker", ["compose", "version", "--short"]), apiRuntime, postgres: postgres.version,
    containers: containers.map((container) => ({ service: container.Config.Labels["com.docker.compose.service"], image: container.Config.Image,
      imageId: container.Image, nanoCpus: container.HostConfig.NanoCpus, memoryLimitBytes: container.HostConfig.Memory })),
    observer: { apiClientAddress: apiAddress, apiApplicationName: "", minimumIntervalMs: 25, extraConnections: 1,
      method: "Read-only aggregate pg_stat_activity and pg_blocking_pids; no query text or PIDs persisted." },
    settings: { concurrency: 10, requests: 2000, monthlyLimit: 4000, totalUsers: 20, repetitions: 3 },
    warmup: { requestsPerShape: 500, separateFixtures: true, sampled: false }, clientAndServerShareMachine: true,
    developmentStackAlsoRunning: true, limitations: ["Sampling perturbs the system; results are diagnostic, not replacement capacity figures.",
      "Samples are backend observations, not request wait durations or independent requests. Short waits can be missed.",
      "One query at a time; effective interval includes query duration and scheduling, not exactly 25 ms.",
      "Pool queue time, CPU and IO utilization are not measured."] });
  const summaries = [];
  const seenAccounts = new Set<string>();
  const serialized: string[] = [];
  for (const round of [0, 1, 2, 3]) for (const shape of (round === 2 ? ["many", "hot"] : ["hot", "many"])) {
    const warmup = round === 0;
    const file = warmup ? `warmup-${shape}` : `${shape}-c10-r${round}`;
    phase = file;
    const runId = randomUUID();
    const runStartedAt = new Date().toISOString();
    const options = parseLoadOptions(["--base-url", baseUrl, "--accounts", shape === "hot" ? "1" : "10",
      "--users-per-account", shape === "hot" ? "20" : "2", "--concurrency", "10", "--requests", warmup ? "500" : "2000", "--monthly-limit", "4000"], {});
    const fixtures = await createLoadFixtures(pool, options, "reliability-local-only-pepper", runId);
    for (const fixture of fixtures) { assert(!seenAccounts.has(fixture.id)); seenAccounts.add(fixture.id); }
    const observed = warmup ? null : await observeWork(() => readLockCounts(observer!, apiAddress, ""), () => runLoad(options, fixtures, runId));
    const measured = observed?.result ?? await runLoad(options, fixtures, runId);
    const verification = await reconcileLoad(pool, fixtures, options, runId, measured);
    const { monthlyLimit: _monthlyLimit, ...settings } = options;
    const report = { schemaVersion: 1, runId, startedAt: runStartedAt, finishedAt: new Date().toISOString(),
      status: verification.passed ? "passed" : "failed", versions, source, machine,
      settings: { ...settings, units: 1, accountMonthlyLimit: 4000, userMonthlyLimit: 4000, requestLimit: options.requests,
        distribution: "round-robin accounts and users", workloadModel: "closed-loop bounded workers" },
      measurements: measured, verification,
      failure: verification.passed ? null : { stage: "reconciliation", message: "Diagnostic accounting/workload checks failed." } };
    await writeLoadResult(join(output, `${file}.json`), report);
    serialized.push(JSON.stringify(report));
    assert(verification.passed, "Workload/reconciliation failed.");
    assert.equal(verification.accounts.length, options.accounts);
    for (const account of verification.accounts) {
      assert.equal(account.accountConsumed, options.requests / options.accounts);
      for (const user of account.users) assert.equal(user.consumed, options.requests / 20);
    }
    if (observed !== null) {
      assert(observed.summary.meanBackends > 0, "Observer did not identify API backends.");
      const evidence = { schemaVersion: 1, runId, rawRun: `${file}.json`, minimumIntervalMs: 25,
        summary: observed.summary, samples: observed.samples };
      await writeJson(join(output, `${file}-locks.json`), evidence);
      serialized.push(JSON.stringify(evidence));
      summaries.push({ shape, repetition: round, rawRun: `${file}.json`, locks: `${file}-locks.json`,
        requestsPerSecond: measured.acceptedPerSecond, p95Ms: measured.latencyMs.p95, ...observed.summary });
    }
    console.log(`PASS ${file}: ${measured.counts.accepted} accepts; totals ${verification.accountConsumed}/${verification.sumUserConsumed}/${verification.uniqueAcceptedDecisionUnits}` +
      (observed === null ? " (warmup)" : `; mean account-lock waiters ${observed.summary.meanAccountLockWaiting.toFixed(2)}, samples ${observed.summary.sampleCount}`));
  }
  phase = "result validation and redaction";
  assert.equal(summaries.length, 6);
  const logs = await compose("logs", "--no-color", "api");
  for (const text of [...serialized, logs]) {
    assert(!/umq_[A-Za-z0-9_-]{40,}/.test(text));
    assert(!text.includes("reliability-local-only-pepper"));
    assert(!/postgres(?:ql)?:\/\//.test(text));
  }
  await writeJson(join(output, "summary.json"), { schemaVersion: 1, status: "passed", startedAt, finishedAt: new Date().toISOString(),
    measuredRuns: 6, acceptedMeasuredUnits: 12000, summaries,
    interpretation: "Unweighted sample means of concurrent API backends; not milliseconds, request counts or a decomposition of HTTP latency." });
  completed = true;
  console.log("PASS six diagnostic runs reconciled; raw load results and lock samples saved.");
} catch {
  console.error(`FAIL lock diagnostics during ${phase}; private errors omitted; no successful diagnostic claim. Existing evidence retained.`);
  process.exitCode = 1;
} finally {
  try { await Promise.all([pool?.end(), observer?.end()]); } catch { process.exitCode = 1; }
  if (attempted) try {
    await compose("down", "--remove-orphans");
    if (completed) {
      const volumes = JSON.parse(await command("docker", ["volume", "inspect", volumeName])) as { Name: string; Labels: Record<string, string> }[];
      assert.equal(volumes.length, 1);
      assert.equal(volumes[0]!.Name, volumeName);
      assert.equal(volumes[0]!.Labels["com.docker.compose.project"], project);
      assert.equal(volumes[0]!.Labels["com.docker.compose.volume"], "postgres_data");
      await command("docker", ["volume", "rm", volumeName]);
      console.log("PASS ownership-verified diagnostic containers/network/volume removed; development data untouched.");
    } else console.error(`Disposable diagnostic volume retained: ${volumeName}`);
  } catch { console.error(`Cleanup requires attention for ${project}.`); process.exitCode = 1; }
}
