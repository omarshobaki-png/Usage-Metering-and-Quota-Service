import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Pool } from "pg";

const runFile = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const project = `quota-compose-${randomUUID()}`;
const volumeName = `${project}_postgres_data`;
const pepper = randomBytes(32).toString("hex");
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: "compose.yaml",
  COMPOSE_PROFILES: "",
  API_PORT: "127.0.0.1:0",
  POSTGRES_PORT: "127.0.0.1:0",
  API_KEY_PEPPER: pepper
};
let pool: Pool | undefined;
let attempted = false;
let completed = false;
let phase = "startup";
const foregroundClients: {
  process: ReturnType<typeof spawn>;
  closed: Promise<void>;
  output: () => string;
}[] = [];

function pass(message: string): void { console.log(`PASS ${message}`); }

function safeMessage(value: string): string {
  return value.replace(/umq_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replaceAll(pepper, "[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[REDACTED_DATABASE_URL]")
    .split("\n")[0]!.slice(0, 200);
}

async function docker(...args: string[]): Promise<string> {
  try {
    return (await runFile("docker", args, {
      cwd: root, env: environment, timeout: 240_000, maxBuffer: 8 * 1024 * 1024
    })).stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim() ?? "No diagnostic output.";
    throw new Error(`Docker ${args.slice(0, 3).join(" ")} failed: ${safeMessage(stderr)}`);
  }
}

function compose(...args: string[]): Promise<string> {
  return docker("compose", ...args);
}

interface ServiceState {
  ID: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

async function services(): Promise<ServiceState[]> {
  const output = await compose("ps", "--all", "--format", "json");
  if (output === "") return [];
  // Compose versions return either a JSON array or one JSON object per line.
  return output.startsWith("[")
    ? JSON.parse(output) as ServiceState[]
    : output.split("\n").map((line) => JSON.parse(line) as ServiceState);
}

async function startAndRunDemo(label: string): Promise<string> {
  console.log(`${label}: docker compose up --build`);
  // Use the exact required foreground command and the real default Compose file.
  // Only project name, ephemeral host ports, and test pepper are overridden.
  const child = spawn("docker", ["compose", "up", "--build"], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let ended = false;
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4_000_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => { ended = true; resolve(); });
    child.once("close", () => { ended = true; resolve(); });
  });
  foregroundClients.push({ process: child, closed, output: () => output });

  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      assert(!ended, "Compose exited before the demo completed.");
      const state = await services();
      for (const name of ["init", "demo"]) {
        const service = state.find((entry) => entry.Service === name);
        if (service?.State === "exited") {
          assert.equal(service.ExitCode, 0, `${name} exited unsuccessfully.`);
        }
      }
      const demo = state.find((entry) => entry.Service === "demo");
      if (demo?.State === "exited" && demo.ExitCode === 0) {
        for (const name of ["db", "api"]) {
          assert.equal(state.find((entry) => entry.Service === name)?.Health, "healthy");
        }
        const logs = await compose("logs", "--no-color", "demo");
        assert(!/umq_[A-Za-z0-9_-]{43}/.test(logs), "Demo logs leaked a key.");
        assert(!logs.includes(pepper), "Demo logs leaked the pepper.");
        assert(logs.includes("Demo completed successfully."));
        const accountId = /Created fresh dedicated demo account ([0-9a-f-]{36})\./.exec(logs)?.[1];
        assert(accountId !== undefined, "Demo did not identify its fresh account.");
        console.log(logs);
        return accountId;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("Compose demo did not complete within three minutes.");
  } finally {
    // Leave foreground Compose running until the explicit down. Closing it here
    // can also stop its attached containers before the persistence assertions.
    assert(!/umq_[A-Za-z0-9_-]{43}/.test(output), "Foreground output leaked a key.");
    assert(!output.includes(pepper), "Foreground output leaked the pepper.");
  }
}

async function closeForegroundClients(): Promise<void> {
  for (const client of foregroundClients.splice(0)) {
    // Called only after down has stopped the disposable containers.
    client.process.kill("SIGKILL");
    await client.closed;
    assert(!/umq_[A-Za-z0-9_-]{43}/.test(client.output()), "Foreground output leaked a key.");
    assert(!client.output().includes(pepper), "Foreground output leaked the pepper.");
  }
}

async function connect(): Promise<Pool> {
  const published = await compose("port", "db", "5432");
  const port = /^127\.0\.0\.1:(\d+)$/.exec(published)?.[1];
  assert(port !== undefined, "Expected one random localhost PostgreSQL port.");
  return new Pool({
    connectionString: `postgres://usage_metering:usage_metering_dev@127.0.0.1:${port}/usage_metering`,
    connectionTimeoutMillis: 5_000,
    options: "-c statement_timeout=5000"
  });
}

function database(): Pool {
  assert(pool !== undefined);
  return pool;
}

async function snapshot(accountId: string): Promise<string> {
  const state: Record<string, unknown> = {};
  const sources = [
    ["accounts", "id"], ["plans", "owner_account_id"], ["users", "account_id"],
    ["account_monthly_usage", "account_id"], ["user_monthly_usage", "account_id"],
    ["request_decisions", "account_id"]
  ] as const;
  for (const [table, accountColumn] of sources) {
    // Fixed internal identifiers; strip the account digest even from private snapshots.
    state[table] = (await database().query(
      `SELECT to_jsonb(t) - 'api_key_digest' AS row FROM ${table} t
       WHERE ${accountColumn} = $1 ORDER BY to_jsonb(t)::text`, [accountId]
    )).rows;
  }
  return JSON.stringify(state);
}

async function verifyFixture(accountId: string): Promise<void> {
  const account = (await database().query(`
    SELECT a.account_plan_id, p.name, p.monthly_limit, p.max_units_per_request,
           p.revision, p.owner_account_id
    FROM accounts a JOIN plans p ON p.id = a.account_plan_id WHERE a.id = $1
  `, [accountId])).rows[0];
  assert(account !== undefined);
  assert.equal(account.name, "Demo Account");
  assert.equal(account.monthly_limit, 50);
  assert.equal(account.max_units_per_request, 100);
  assert.equal(account.revision, 2);
  assert.equal(account.owner_account_id, accountId);
  assert.deepEqual((await database().query(`
    SELECT p.name, p.monthly_limit, p.max_units_per_request, m.consumed_units
    FROM users u JOIN plans p ON p.id = u.user_plan_id
    JOIN user_monthly_usage m ON m.user_id = u.id AND m.account_id = u.account_id
    WHERE u.account_id = $1 ORDER BY p.name
  `, [accountId])).rows, [
    { name: "Demo Basic", monthly_limit: 10, max_units_per_request: 5, consumed_units: 4 },
    { name: "Demo Premium", monthly_limit: 30, max_units_per_request: 20, consumed_units: 27 }
  ]);
  assert.deepEqual((await database().query(
    "SELECT consumed_units FROM account_monthly_usage WHERE account_id = $1", [accountId]
  )).rows, [{ consumed_units: 31 }]);
  assert.deepEqual((await database().query(`
    SELECT count(*)::integer AS decisions,
           count(*) FILTER (WHERE accepted)::integer AS accepted,
           sum(requested_units) FILTER (WHERE accepted)::integer AS units
    FROM request_decisions WHERE account_id = $1
  `, [accountId])).rows, [{ decisions: 5, accepted: 3, units: 31 }]);
}

async function seedSnapshot(): Promise<string> {
  const rows = (await database().query(
    "SELECT to_jsonb(p) AS row FROM plans p WHERE owner_account_id IS NULL ORDER BY id"
  )).rows;
  assert.equal(rows.length, 4, "Predefined plans were duplicated or lost.");
  return JSON.stringify(rows);
}

async function checkedVolume(): Promise<void> {
  assert(/^quota-compose-[0-9a-f-]{36}_postgres_data$/.test(volumeName));
  const volumes = JSON.parse(await docker("volume", "inspect", volumeName)) as {
    Name: string; Labels: Record<string, string>;
  }[];
  assert.equal(volumes[0]?.Name, volumeName);
  assert.equal(volumes[0]?.Labels["com.docker.compose.project"], project);
}

try {
  console.log(`verification started ${new Date().toISOString()}`);
  attempted = true;
  phase = "fresh default Compose startup";
  const firstAccount = await startAndRunDemo("Fresh start");
  phase = "fresh fixture and volume assertions";
  pool = await connect();
  await verifyFixture(firstAccount);
  const original = await snapshot(firstAccount);
  const seeds = await seedSnapshot();
  await checkedVolume();
  pass("fresh startup: healthy db/API, init and demo exit 0; five decisions total 31 units");
  await pool.end();
  pool = undefined;

  phase = "stop and remove containers while preserving volume";
  await compose("down");
  await closeForegroundClients();
  await checkedVolume();
  pass("down retained the same dedicated PostgreSQL volume");

  phase = "second default Compose startup";
  const secondAccount = await startAndRunDemo("Restart with retained volume");
  assert.notEqual(secondAccount, firstAccount);
  pool = await connect();
  await verifyFixture(firstAccount);
  assert.equal(await snapshot(firstAccount), original, "Existing demo data changed across restart.");
  await verifyFixture(secondAccount);
  assert.equal(await seedSnapshot(), seeds, "Predefined plans changed across startup.");
  assert.equal((await database().query("SELECT count(*)::integer AS count FROM accounts")).rows[0]?.count, 2);
  pass("restart: original account's 31 units, plans, assignments and exact history preserved");
  pass("second demo used a fresh account; exactly four predefined plans remain unchanged");

  phase = "log redaction";
  const logs = await compose("logs", "--no-color");
  assert(!/umq_[A-Za-z0-9_-]{43}/.test(logs), "Service logs leaked a key.");
  assert(!logs.includes(pepper), "Service logs leaked the pepper.");
  pass("foreground and service logs contain no raw API key or pepper");
  completed = true;
  console.log(`verification completed ${new Date().toISOString()}`);
} catch (error) {
  console.error(`FAIL verification during ${phase}; credentials and private snapshots omitted.`);
  if (error instanceof Error) {
    console.error(`Reason: ${safeMessage(error.message)}`);
  }
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
    if (attempted) {
      phase = "isolated cleanup";
      await compose("down", "--remove-orphans");
      await closeForegroundClients();
      if (completed) {
        await checkedVolume();
        await docker("volume", "rm", volumeName);
        pass("cleanup: only the verified disposable stack/volume removed; development stack untouched");
      } else console.error(`Disposable volume retained for diagnosis if created: ${volumeName}`);
    }
  } catch {
    // A failed down must not leave the foreground CLI keeping this runner alive.
    for (const client of foregroundClients.splice(0)) client.process.kill("SIGKILL");
    console.error(`Cleanup needs attention for disposable project ${project}.`);
    process.exitCode = 1;
  }
}
