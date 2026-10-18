import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Pool } from "pg";

import { provisionAccount, type ProvisionedAccount } from "../src/modules/accounts/provision-account.js";
import type { Plan } from "../src/modules/plans/service.js";
import { parseConsumptionDecision, type ConsumeRequest, type ConsumptionDecision } from "../src/modules/usage/contract.js";
import type { User } from "../src/modules/users/service.js";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const project = `quota-reliability-${randomUUID()}`;
const image = `${project}-api`;
const expectedVolume = `${project}_postgres_data`;
const composeArgs = ["compose", "-p", project, "-f", "compose.reliability.yaml"];
const environment = { ...process.env, RELIABILITY_API_IMAGE: image };
const pepper = "reliability-local-only-pepper";
const secrets = [pepper, "reliability-local-only"];
const startedAt = new Date().toISOString();
let phase = "startup";
let stackAttempted = false;
let completed = false;
let pool: Pool | undefined;
let apiOrigin = "";
let databaseUrl = "";

interface RecordedDecision { input: ConsumeRequest; response: ConsumptionDecision }
interface Scenario {
  account: ProvisionedAccount;
  userId: string;
  userPlanId: number;
  decisions: RecordedDecision[];
}

function pass(label: string) { console.log(`PASS ${label}`); }
function redact(value: string) {
  let output = value.replace(/umq_[A-Za-z0-9_-]+/g, "[REDACTED]");
  for (const secret of secrets) output = output.replaceAll(secret, "[REDACTED]");
  return output.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[REDACTED_DATABASE_URL]");
}

async function command(file: string, args: string[], env: NodeJS.ProcessEnv = environment) {
  try {
    return (await runFile(file, args, {
      cwd: root, env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024
    })).stdout.trim();
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const detail = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`.trim();
    if (detail) console.error(redact(detail));
    throw new Error(`Command failed during ${phase}.`);
  }
}

function compose(...args: string[]) { return command("docker", [...composeArgs, ...args]); }
function database(): Pool {
  assert(pool !== undefined, "Reliability pool must be available.");
  return pool;
}
function openPool() {
  const result = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 2_000 });
  // Readiness checks handle transient disconnections, never log connection secrets.
  result.on("error", () => undefined);
  return result;
}

async function port(service: string, target: string) {
  const published = await compose("port", service, target);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
  assert(match !== null, "Expected exactly one random localhost port.");
  return Number(match[1]);
}

async function ready() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      await database().query("SELECT 1");
      const health = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(3_000) });
      if (health.ok) return;
    } catch { /* Expected during startup/recovery; bounded retry, no mutations. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("API/database did not become ready within 45 seconds.");
}

async function api<T>(path: string, key: string | undefined, status = 200, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method, headers: {
      ...(key === undefined ? {} : { "x-api-key": key }),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000)
  });
  assert.equal(response.status, status, `Unexpected status for ${method} ${path}.`);
  const text = await response.text();
  for (const secret of secrets) assert(!text.includes(secret), "HTTP response leaked a secret.");
  return JSON.parse(text) as T;
}

async function snapshot() {
  const tables = ["accounts", "plans", "users", "account_monthly_usage", "user_monthly_usage", "request_decisions", "schema_migrations"];
  const state: Record<string, unknown> = {};
  for (const table of tables) {
    // Fixed internal table list only; secrets stay in memory, never in the report.
    state[table] = (await database().query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return JSON.stringify(state);
}

async function scenario(index: number): Promise<Scenario> {
  const account = await provisionAccount(database(), { name: `Reliability ${index}`, apiKeyPepper: pepper });
  secrets.push(account.apiKey);
  const accountPlan = (await api<{ plan: Plan }>("/plans", account.apiKey, 201, "POST", {
    name: `Account ${index}`, scope: "account", monthlyLimit: 30, requestLimit: 100
  })).plan;
  const userPlan = (await api<{ plan: Plan }>("/plans", account.apiKey, 201, "POST", {
    name: `User ${index}`, scope: "user", monthlyLimit: 10, requestLimit: 5
  })).plan;
  await api("/account/plan", account.apiKey, 200, "PATCH", { planId: accountPlan.id });
  const user = (await api<{ user: User }>("/users", account.apiKey, 201, "POST", { planId: userPlan.id })).user;
  const decisions: RecordedDecision[] = [];
  for (const [requestId, units, accepted] of [["accepted-original", index === 1 ? 4 : 3, true], ["rejected-original", 6, false]] as const) {
    const input = { userId: user.id, units, requestId };
    const response = parseConsumptionDecision(await api("/consume", account.apiKey, 200, "POST", input));
    assert.equal(response.accepted, accepted);
    decisions.push({ input, response });
  }
  const edit = await api<{ plan: Plan }>(`/plans/${userPlan.id}`, account.apiKey, 200, "PATCH", {
    monthlyLimit: 20, requestLimit: 10
  });
  assert.equal(edit.plan.revision, 2);
  const input = { userId: user.id, units: 6, requestId: "accepted-after-edit" };
  const response = parseConsumptionDecision(await api("/consume", account.apiKey, 200, "POST", input));
  assert.equal(response.accepted, true);
  decisions.push({ input, response });
  return { account, userId: user.id, userPlanId: userPlan.id, decisions };
}

async function views(scenarios: Scenario[]) {
  const result: unknown[] = [];
  for (const entry of scenarios) {
    const key = entry.account.apiKey;
    const account = await api<{ account: { id: string } }>("/account", key);
    assert.equal(account.account.id, entry.account.id);
    result.push(account, await api(`/users/${entry.userId}`, key), await api(`/plans/${entry.userPlanId}`, key), await api("/plans", key));
  }
  return result;
}

async function verify(scenarios: Scenario[], expectedState: string, expectedViews: unknown[]) {
  assert.equal(await snapshot(), expectedState, "Persisted rows changed across restart.");
  assert.deepEqual(await views(scenarios), expectedViews);
  for (const entry of scenarios) {
    for (const saved of entry.decisions) {
      const replay = await api("/consume", entry.account.apiKey, 200, "POST", saved.input);
      assert.deepEqual(replay, saved.response);
    }
  }
  await api("/account", undefined, 401);
  await api("/account", "invalid-key", 401);
  await api(`/users/${scenarios[1]!.userId}`, scenarios[0]!.account.apiKey, 404);
  await api(`/plans/${scenarios[1]!.userPlanId}`, scenarios[0]!.account.apiKey, 404);
  assert.equal(await snapshot(), expectedState, "Replay/authentication checks changed stored data.");
}

async function reconcile(expected: number[]) {
  const totals = await database().query<{ account: number; users: number; ledger: number }>(`
    SELECT
      COALESCE((SELECT SUM(consumed_units) FROM account_monthly_usage a WHERE a.account_id = accounts.id),0)::integer AS account,
      COALESCE((SELECT SUM(consumed_units) FROM user_monthly_usage u WHERE u.account_id = accounts.id),0)::integer AS users,
      COALESCE((SELECT SUM(requested_units) FROM request_decisions d WHERE d.account_id = accounts.id AND d.accepted),0)::integer AS ledger
    FROM accounts ORDER BY name
  `);
  assert.deepEqual(totals.rows, expected.map((total) => ({ account: total, users: total, ledger: total })));
  const mismatches = await database().query(`
    SELECT u.user_id FROM user_monthly_usage u WHERE u.consumed_units <>
      (SELECT COALESCE(SUM(d.requested_units),0) FROM request_decisions d
       WHERE d.account_id=u.account_id AND d.user_id=u.user_id AND d.processed_month=u.usage_month AND d.accepted)
  `);
  assert.equal(mismatches.rowCount, 0);
}

async function container(service: string) {
  const id = await compose("ps", "-q", service);
  assert(/^[a-f0-9]{12,64}$/.test(id), "Expected one running test container.");
  const details = JSON.parse(await command("docker", ["inspect", id])) as {
    State: { StartedAt: string }; Mounts: { Destination: string; Name?: string }[];
    Config: { Labels: Record<string, string> };
  }[];
  assert.equal(details[0]!.Config.Labels["com.docker.compose.project"], project);
  return details[0]!;
}

try {
  console.log(`Reliability verification started ${startedAt}`);
  phase = "normal Compose shared-pepper regression";
  const normalCompose = ["compose", "--env-file", ".env.example", "-f", "compose.yaml", "config", "--format", "json"];
  const sharedEnvironment = { ...environment, API_KEY_PEPPER: pepper, POSTGRES_PORT: "55432" };
  const rendered = JSON.parse(await command("docker", normalCompose, sharedEnvironment)) as {
    services: { api: { environment: { API_KEY_PEPPER: string } }; init: { environment: { API_KEY_PEPPER: string } } };
  };
  assert.equal(rendered.services.api.environment.API_KEY_PEPPER, pepper);
  assert.equal(rendered.services.init.environment.API_KEY_PEPPER, pepper);
  let refusedEmptyPepper = false;
  try {
    await runFile("docker", normalCompose, { cwd: root, env: { ...sharedEnvironment, API_KEY_PEPPER: "" }, timeout: 15_000 });
  } catch (error) {
    refusedEmptyPepper = String((error as { stderr?: string }).stderr).includes("API_KEY_PEPPER");
  }
  assert(refusedEmptyPepper, "Normal Compose must refuse an empty API-key pepper.");
  pass("normal Compose regression: api/init share the supplied pepper and empty pepper is refused");
  phase = "isolated Compose build/start";
  stackAttempted = true;
  await compose("up", "-d", "--build", "--wait", "--wait-timeout", "90");
  apiOrigin = `http://127.0.0.1:${await port("api", "3000")}`;
  databaseUrl = `postgres://quota_reliability:reliability-local-only@127.0.0.1:${await port("db", "5432")}/quota_reliability`;
  pool = openPool();
  await ready();
  const dbBefore = await container("db");
  const volume = dbBefore.Mounts.find((mount) => mount.Destination === "/var/lib/postgresql/data")?.Name;
  assert.equal(volume, expectedVolume);
  const serverVersion = (await database().query<{ server_version: string }>("SHOW server_version")).rows[0]!.server_version;
  console.log(`Runtime Node ${process.version}; PostgreSQL ${serverVersion}; Compose ${await command("docker", ["compose", "version", "--short"])}`);
  pass("isolated stack healthy; random localhost ports and dedicated named volume");

  phase = "meter chapter regression checkpoint";
  const output = await command(process.execPath, ["./node_modules/vitest/vitest.mjs", "run"], {
    ...environment, TEST_DATABASE_URL: databaseUrl
  });
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const testSummary = plain.split("\n").find((line) => /^\s*Tests\s+\d+ passed/.test(line));
  assert(testSummary !== undefined, "Test runner did not report a passing test count.");
  pass(`meter chapter checkpoint: ${testSummary.trim()}`);

  phase = "recording baseline";
  const scenarios = [await scenario(1), await scenario(2)];
  const expectedState = await snapshot();
  const expectedViews = await views(scenarios);
  await verify(scenarios, expectedState, expectedViews);
  await reconcile([10, 9]);
  console.log(`Baseline SHA-256 ${createHash("sha256").update(expectedState).digest("hex")}`);
  pass("baseline: two accounts/users, four custom plans, edited revisions, six decisions, totals 10 and 9");

  phase = "actual API restart";
  const apiBefore = await container("api");
  await compose("restart", "api");
  // Docker can reassign published port 0 on restart; rediscover it rather than
  // mistaking a stale test URL for application recovery failure.
  apiOrigin = `http://127.0.0.1:${await port("api", "3000")}`;
  await ready();
  const apiAfter = await container("api");
  assert.notEqual(apiAfter.State.StartedAt, apiBefore.State.StartedAt);
  await verify(scenarios, expectedState, expectedViews);
  await reconcile([10, 9]);
  pass("actual API restart: all rows/views, original keys, tenant isolation and accepted/rejected replays preserved");

  phase = "actual PostgreSQL restart with retained volume";
  const previousStart = (await database().query<{ started: Date }>("SELECT pg_postmaster_start_time() AS started")).rows[0]!.started;
  await database().end();
  pool = undefined;
  await compose("restart", "db");
  databaseUrl = `postgres://quota_reliability:reliability-local-only@127.0.0.1:${await port("db", "5432")}/quota_reliability`;
  pool = openPool();
  await ready();
  const dbAfter = await container("db");
  assert.notEqual(dbAfter.State.StartedAt, dbBefore.State.StartedAt);
  assert.equal(dbAfter.Mounts.find((mount) => mount.Destination === "/var/lib/postgresql/data")?.Name, expectedVolume);
  const nextStart = (await database().query<{ started: Date }>("SELECT pg_postmaster_start_time() AS started")).rows[0]!.started;
  assert(nextStart.getTime() > previousStart.getTime());
  assert.equal((await container("api")).State.StartedAt, apiAfter.State.StartedAt, "API should recover its DB pool without another restart.");
  await verify(scenarios, expectedState, expectedViews);
  await reconcile([10, 9]);
  pass("actual PostgreSQL restart: same volume and exact data preserved; API pool reconnected without restarting API");

  phase = "new writes after recovery and log redaction";
  for (const [index, entry] of scenarios.entries()) {
    const response = parseConsumptionDecision(await api("/consume", entry.account.apiKey, 200, "POST", {
      userId: entry.userId, units: index === 0 ? 2 : 1, requestId: "after-db-restart"
    }));
    assert.equal(response.accepted, true);
  }
  await reconcile([12, 10]);
  const logs = await compose("logs", "--no-color", "api");
  for (const secret of secrets) assert(!logs.includes(secret), "API logs leaked a secret.");
  pass("new post-recovery writes reconcile at 12 and 10; API responses/logs contain no keys, pepper or DB password");
  completed = true;
  console.log(`Reliability verification completed ${new Date().toISOString()}`);
} catch {
  // Assertion details may contain private in-memory snapshots; never print them.
  console.error(`FAIL reliability verification during ${phase}; private snapshots and credentials omitted.`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
  } catch {
    console.error("Test pool cleanup failed; continuing isolated Docker cleanup.");
    process.exitCode = 1;
  }
  if (stackAttempted) {
    try {
      phase = "isolated stack cleanup";
      await compose("down", "--remove-orphans"); // Never remove a volume during restart verification.
      if (completed) {
        const volume = JSON.parse(await command("docker", ["volume", "inspect", expectedVolume])) as {
          Name: string; Labels: Record<string, string>;
        }[];
        assert.equal(volume[0]!.Name, expectedVolume);
        assert.equal(volume[0]!.Labels["com.docker.compose.project"], project);
        // Verification is over; delete only the validated disposable test volume.
        await command("docker", ["volume", "rm", expectedVolume]);
        pass("cleanup: isolated containers/network/test volume removed; development stack untouched");
      } else console.error(`Test volume retained for diagnosis if created: ${expectedVolume}`);
    } catch {
      console.error(`Cleanup needs attention for isolated project ${project}; no development resources targeted.`);
      process.exitCode = 1;
    }
  }
}
