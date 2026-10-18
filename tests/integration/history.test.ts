import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { createApiKeyAuthenticator } from "../../src/middleware/authenticate-api-key.js";
import { assignAccountPlan, assignUserPlan } from "../../src/modules/plans/assignment.js";
import { createCustomPlan, getPlan, listPlans, updateCustomPlan } from "../../src/modules/plans/service.js";
import { consume, type ConsumeOptions } from "../../src/modules/usage/consume.js";
import { readHistory, type HistoryPage } from "../../src/modules/usage/history.js";
import { createUser, getUser } from "../../src/modules/users/service.js";
import { createTwoAccountFixture, type TwoAccountFixture } from "../fixtures/two-account.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for history tests.");
const schemaName = `history_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
const pool = new Pool({
  connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 3_000,
  options: `-c search_path=${schemaName} -c timezone=Pacific/Honolulu -c statement_timeout=5000`
});
const pepper = "history-test-pepper-value";
const apps: FastifyInstance[] = [];
let fixture: TwoAccountFixture;
let instant = "2026-10-31T23:59:59Z";
const clock = () => new Date(instant);

function createTestApp(options: ConsumeOptions = {}) {
  const app = buildApp({
    checkDatabase: async () => { await pool.query("SELECT 1"); },
    authenticateAccount: createApiKeyAuthenticator(pool, pepper),
    userOperations: {
      createUser: async (accountId, input) => createUser(pool, accountId, input),
      getUser: async (accountId, userId) => getUser(pool, accountId, userId)
    },
    planOperations: {
      createCustomPlan: async (accountId, input) => createCustomPlan(pool, accountId, input),
      getPlan: async (accountId, id) => getPlan(pool, accountId, id),
      listPlans: async (accountId, scope) => listPlans(pool, accountId, scope),
      updateCustomPlan: async (accountId, id, input) => updateCustomPlan(pool, accountId, id, input)
    },
    assignmentOperations: {
      assignAccountPlan: async (accountId, id) => assignAccountPlan(pool, accountId, id),
      assignUserPlan: async (accountId, userId, id) => assignUserPlan(pool, accountId, userId, id)
    },
    consumptionOperations: { consume: async (accountId, input) => consume(pool, accountId, input, { clock, ...options }) },
    historyOperations: { readHistory: async (accountId, query) => readHistory(pool, accountId, query) },
    logger: false
  });
  apps.push(app);
  return app;
}

async function history(app: FastifyInstance, query = "", key = fixture.accountA.apiKey): Promise<HistoryPage> {
  const response = await app.inject({ method: "GET", url: `/history${query}`, headers: { "x-api-key": key } });
  expect(response.statusCode).toBe(200);
  return response.json<HistoryPage>();
}

async function spend(app: FastifyInstance, requestId: string, units = 1, userId = fixture.userA.id, key = fixture.accountA.apiKey) {
  const response = await app.inject({
    method: "POST", url: "/consume", headers: { "x-api-key": key }, payload: { requestId, units, userId }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function state() {
  return (await pool.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY account_id, request_id), '[]') FROM request_decisions d) AS decisions,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY account_id, usage_month), '[]') FROM account_monthly_usage a) AS accounts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY user_id, usage_month), '[]') FROM user_monthly_usage u) AS users
  `)).rows[0];
}

function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value: string) { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
});
beforeEach(async () => {
  instant = "2026-10-31T23:59:59Z";
  await pool.query(`
    DELETE FROM request_decisions; DELETE FROM user_monthly_usage; DELETE FROM account_monthly_usage;
    DELETE FROM users; UPDATE accounts SET account_plan_id = 1;
    DELETE FROM plans WHERE owner_account_id IS NOT NULL; DELETE FROM accounts;
  `);
  fixture = await createTwoAccountFixture(pool, pepper);
});
afterEach(async () => { await Promise.all(apps.splice(0).map(async (app) => app.close())); });
afterAll(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await adminPool.end();
});

describe("tenant-scoped decision history", () => {
  it("returns an empty terminal page for an unused account or owned user without writing", async () => {
    const app = createTestApp();
    const before = await state();
    expect(await history(app)).toEqual({ decisions: [], nextCursor: null });
    expect(await history(app, `?userId=${fixture.userA.id}&month=2026-10`)).toEqual({ decisions: [], nextCursor: null });
    expect(await state()).toEqual(before);
  });

  it("pages five tied-timestamp decisions 2/2/1 while a sixth stays outside the browsing session", async () => {
    const app = createTestApp();
    for (const [id, units] of [["z-oldest", 1], ["b-rejected", 25], ["m-middle", 2], ["a-next", 1], ["y-newest", 1]] as const) {
      await spend(app, id, units);
    }
    const first = await history(app, "?limit=2");
    expect(first.decisions.map((row) => row.requestId)).toEqual(["y-newest", "a-next"]);
    expect(first.nextCursor).not.toBeNull();
    // Even a processing clock that moves backward must not reorder pagination.
    instant = "2026-09-30T23:59:59Z";
    await spend(app, "sixth");
    const second = await history(app, `?limit=2&cursor=${first.nextCursor}`);
    const third = await history(app, `?limit=2&cursor=${second.nextCursor}`);
    expect(second.decisions.map((row) => row.requestId)).toEqual(["m-middle", "b-rejected"]);
    expect(third.decisions.map((row) => row.requestId)).toEqual(["z-oldest"]);
    expect(third.nextCursor).toBeNull();
    const original = [...first.decisions, ...second.decisions, ...third.decisions];
    expect(new Set(original.map((row) => row.sequence)).size).toBe(5);
    expect(new Set(original.map((row) => row.processedAt)).size).toBe(1);
    expect(original.filter((row) => !row.accepted)).toHaveLength(1);
    expect((await history(app)).decisions.map((row) => row.requestId)).toEqual([
      "sixth", "y-newest", "a-next", "m-middle", "b-rejected", "z-oldest"
    ]);
  });

  it("returns the exact saved accepted/rejected responses and allowance snapshots without writes or secret fields", async () => {
    const app = createTestApp();
    const accepted = await spend(app, "accepted", 4);
    const rejected = await spend(app, "rejected", 25);
    const before = await state();
    const page = await history(app);
    expect(page.decisions.map((row) => row.requestId)).toEqual(["rejected", "accepted"]);
    for (const entry of page.decisions) {
      const { sequence, evaluatedLimits, ...response } = entry;
      expect(sequence).toMatch(/^[1-9][0-9]*$/);
      expect(response).toEqual(entry.accepted ? accepted : rejected);
      expect(evaluatedLimits).toEqual({
        account: { monthlyLimit: 10_000, maxUnitsPerRequest: 100 },
        user: { monthlyLimit: 1_000, maxUnitsPerRequest: 20 }
      });
    }
    expect(page.decisions[0]).toMatchObject({ blockedBy: { scope: "user", rule: "max_units_per_request", limit: 20 } });
    const body = JSON.stringify(page);
    for (const forbidden of [fixture.accountA.apiKey, fixture.accountB.apiKey, pepper, "api_key_digest", "DATABASE_URL"]) {
      expect(body).not.toContain(forbidden);
    }
    expect(await state()).toEqual(before);
  });

  it("keeps accepted/rejected history unchanged after API plan edits, assignment switches, and replay", async () => {
    const app = createTestApp();
    await assignUserPlan(pool, fixture.accountA.id, fixture.userA.id, fixture.customPlanA.id);
    await spend(app, "old-accepted", 4);
    await spend(app, "old-rejected", 6);
    const original = await history(app);
    const edit = await app.inject({ method: "PATCH", url: `/plans/${fixture.customPlanA.id}`,
      headers: { "x-api-key": fixture.accountA.apiKey }, payload: { monthlyLimit: 100, requestLimit: 20 } });
    expect(edit.statusCode).toBe(200);
    const switchPlan = await app.inject({ method: "PATCH", url: `/users/${fixture.userA.id}/plan`,
      headers: { "x-api-key": fixture.accountA.apiKey }, payload: { planId: 4 } });
    expect(switchPlan.statusCode).toBe(200);
    await spend(app, "old-accepted", 4);
    expect((await spend(app, "old-rejected", 6)).accepted).toBe(false);
    expect(await history(app)).toEqual(original);
    expect(original.decisions[0]?.evaluatedLimits.user.maxUnitsPerRequest).toBe(5);
    expect(original.decisions[0]?.user.plan.revision).toBe(1);
    await spend(app, "new-after-switch", 6);
    const fresh = await history(app);
    expect(fresh.decisions.slice(1)).toEqual(original.decisions);
    expect(fresh.decisions[0]).toMatchObject({ accepted: true, user: { plan: { id: 4 } } });
  });

  it("filters by owned user and UTC month, with no implicit current-month filter", async () => {
    const app = createTestApp();
    const second = await createUser(pool, fixture.accountA.id);
    await spend(app, "october-a");
    await spend(app, "october-second", 1, second.id);
    instant = "2026-11-01T00:00:00Z";
    await spend(app, "november-a");
    expect((await history(app)).decisions).toHaveLength(3);
    expect((await history(app, "?month=2026-10")).decisions.map((row) => row.requestId)).toEqual(["october-second", "october-a"]);
    expect((await history(app, `?userId=${fixture.userA.id.toUpperCase()}`)).decisions.map((row) => row.requestId)).toEqual(["november-a", "october-a"]);
    expect((await history(app, `?userId=${fixture.userA.id}&month=2026-10`)).decisions.map((row) => row.requestId)).toEqual(["october-a"]);
    expect(await history(app, "?month=2027-01")).toEqual({ decisions: [], nextCursor: null });
  });

  it("binds continuation cursors to their filters and lets callers change page size", async () => {
    const app = createTestApp();
    for (let i = 1; i <= 4; i += 1) await spend(app, `filtered-${i}`);
    const first = await history(app, `?limit=1&userId=${fixture.userA.id}&month=2026-10`);
    const second = await history(app, `?limit=3&userId=${fixture.userA.id.toUpperCase()}&month=2026-10&cursor=${first.nextCursor}`);
    expect(second.decisions.map((row) => row.requestId)).toEqual(["filtered-3", "filtered-2", "filtered-1"]);
    expect(second.nextCursor).toBeNull();
    for (const filter of ["", `&userId=${fixture.userA.id}`, "&month=2026-10", `&userId=${fixture.userA.id}&month=2026-11`]) {
      const response = await app.inject({ method: "GET", url: `/history?cursor=${first.nextCursor}${filter}`,
        headers: { "x-api-key": fixture.accountA.apiKey } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
    }
  });

  it("isolates accounts and rejects foreign users and foreign cursors, including guessed positions", async () => {
    const app = createTestApp();
    await spend(app, "shared-id");
    await spend(app, "second-a");
    await spend(app, "shared-id", 1, fixture.userB.id, fixture.accountB.apiKey);
    await spend(app, "second-b", 1, fixture.userB.id, fixture.accountB.apiKey);
    const foreign = await history(app, "?limit=1", fixture.accountB.apiKey);
    const response = await app.inject({ method: "GET", url: `/history?cursor=${foreign.nextCursor}`,
      headers: { "x-api-key": fixture.accountA.apiKey } });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(fixture.userB.id);
    for (const userId of [fixture.userB.id, randomUUID()]) {
      const denied = await app.inject({ method: "GET", url: `/history?userId=${userId}`,
        headers: { "x-api-key": fixture.accountA.apiKey } });
      expect(denied.statusCode).toBe(404);
      expect(denied.json().error).toEqual({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    // A cursor is only a position, not authorization. Even a modified cursor
    // cannot bypass the query's authenticated account predicate.
    const forged = encode({ ...decode(foreign.nextCursor!), accountId: fixture.accountA.id });
    const own = await history(app, `?cursor=${forged}`);
    expect(own.decisions.every((row) => row.userId === fixture.userA.id)).toBe(true);
    expect(JSON.stringify(own)).not.toContain(fixture.userB.id);
  });

  it.each(["0", "101", "-1", "1.5", "1e2", "01", "foo", ""])("rejects out-of-contract limit %s", async (limit) => {
    const response = await createTestApp().inject({ method: "GET", url: `/history?limit=${limit}`,
      headers: { "x-api-key": fixture.accountA.apiKey } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
    expect(response.json().error.message).toContain("limit 1–100");
  });

  it("rejects malformed months, user IDs, duplicate and unknown parameters", async () => {
    const app = createTestApp();
    const before = await state();
    for (const query of ["month=2026-13", "month=0000-01", "month=2026-1", "month=2026-10%0A", "userId=bad",
      "limit=1&limit=2", "month=2026-10&month=2026-11", "cursor=a&cursor=b", `accountId=${fixture.accountB.id}`, "offset=2"]) {
      const response = await app.inject({ method: "GET", url: `/history?${query}`, headers: { "x-api-key": fixture.accountA.apiKey } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
    }
    expect(await state()).toEqual(before);
  });

  it("rejects malformed, oversized, noncanonical and invalid-shape cursors safely", async () => {
    const app = createTestApp();
    await spend(app, "one"); await spend(app, "two");
    const first = await history(app, "?limit=1");
    const valid = decode(first.nextCursor!);
    for (const cursor of ["", "!", "a", "a".repeat(1025), `${first.nextCursor}=`, encode(null), encode([]), encode({}),
      encode({ ...valid, upper: "0" }), encode({ ...valid, before: "-1" }), encode({ ...valid, before: "xyz" }),
      encode({ ...valid, upper: "9223372036854775808" }), encode({ ...valid, upper: "1", before: "2" }),
      encode({ ...valid, version: 2 }), encode({ ...valid, extra: true }), encode({ ...valid, userId: "bad" })]) {
      const response = await app.inject({ method: "GET", url: `/history?cursor=${encodeURIComponent(cursor)}`,
        headers: { "x-api-key": fixture.accountA.apiKey } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
      expect(response.body).not.toContain("SELECT");
    }
  });

  it("requires valid authentication before validating history parameters", async () => {
    const app = createTestApp();
    for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": `umq_${"a".repeat(43)}` }]) {
      const response = await app.inject({ method: "GET", url: "/history?limit=0&cursor=bad", headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("UNAUTHORIZED");
    }
  });

  it("uses default 20 and maximum 100 with correct terminal cursors", async () => {
    const app = createTestApp();
    for (let i = 0; i < 101; i += 1) await spend(app, `bulk-${i}`);
    expect((await history(app)).decisions).toHaveLength(20);
    const large = await history(app, "?limit=100");
    expect(large.decisions).toHaveLength(100);
    const last = await history(app, `?limit=100&cursor=${large.nextCursor}`);
    expect(last.decisions).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  }, 15_000);

  it("keeps sequence positions exact beyond JavaScript's safe integer bound", async () => {
    await pool.query("SELECT setval(pg_get_serial_sequence('request_decisions','decision_sequence'), 9007199254740992, false)");
    const app = createTestApp();
    await spend(app, "large-first"); await spend(app, "large-second");
    const first = await history(app, "?limit=1");
    expect(first.decisions[0]?.sequence).toBe("9007199254740993");
    const next = await history(app, `?limit=1&cursor=${first.nextCursor}`);
    expect(next.decisions[0]?.sequence).toBe("9007199254740992");
    expect(next.nextCursor).toBeNull();
  });

  it("excludes an in-flight decision that commits after the first page", async () => {
    const app = createTestApp();
    for (const id of ["first", "second", "third"]) await spend(app, id);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedApp = createTestApp({ testHooks: { afterDecisionInsert: async () => { entered(); await gate; } } });
    await gatedApp.ready();
    const pending = spend(gatedApp, "in-flight");
    let first: HistoryPage;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([paused, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Consumption did not reach its gate.")), 3_000);
      })]);
      first = await history(app, "?limit=1");
      expect(first.decisions[0]?.requestId).toBe("third");
    } finally {
      clearTimeout(timer); release(); await pending;
    }
    const rest = await history(app, `?cursor=${first.nextCursor}`);
    expect(rest.decisions.map((row) => row.requestId)).toEqual(["second", "first"]);
    expect(rest.nextCursor).toBeNull();
    expect((await history(app)).decisions[0]?.requestId).toBe("in-flight");
  });

  it("survives a rolled-back sequence gap and an application/pool restart without duplicate history", async () => {
    const app = createTestApp();
    await spend(app, "committed-before");
    await expect(consume(pool, fixture.accountA.id, { userId: fixture.userA.id, units: 1, requestId: "rolled-back" }, {
      clock, testHooks: { afterDecisionInsert: () => { throw new Error("Rollback history insertion."); } }
    })).rejects.toThrow("Rollback history insertion.");
    await spend(app, "committed-after");
    const before = await history(app, "?limit=1");
    const replacementPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}`, max: 1 });
    try {
      const continuation = await readHistory(replacementPool, fixture.accountA.id, { limit: 20, cursor: before.nextCursor! });
      expect(continuation.decisions.map((row) => row.requestId)).toEqual(["committed-before"]);
      expect(continuation.nextCursor).toBeNull();
    } finally { await replacementPool.end(); }
    const replacementApp = createTestApp();
    expect(await history(replacementApp)).toEqual(await history(app));
  });

  it("upgrades existing decisions deterministically, preserving every old field and making migration repeatable", async () => {
    const legacySchema = `legacy_history_${randomUUID().replaceAll("-", "")}`;
    const legacyPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema}`, max: 2 });
    try {
      await adminPool.query(`CREATE SCHEMA "${legacySchema}"`);
      await legacyPool.query("CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const filename of ["initial_schema.sql", "modification_1_plan_ids_as_integers.sql"]) {
        await legacyPool.query(await readFile(resolve("src/db/migrations", filename), "utf8"));
        await legacyPool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [filename]);
      }
      await seedPredefinedPlans(legacyPool);
      const old = await createTwoAccountFixture(legacyPool, pepper);
      for (const requestId of ["z", "a"]) {
        await consume(legacyPool, old.accountA.id, { userId: old.userA.id, units: 1, requestId }, { clock });
      }
      const previous = (await legacyPool.query("SELECT to_jsonb(d) AS row FROM request_decisions d ORDER BY request_id")).rows;
      await expect(runMigrations(legacyPool)).resolves.toEqual(["modification_2_decision_history_sequence.sql"]);
      await expect(runMigrations(legacyPool)).resolves.toEqual([]);
      expect((await legacyPool.query("SELECT to_jsonb(d) - 'decision_sequence' AS row FROM request_decisions d ORDER BY request_id")).rows).toEqual(previous);
      expect((await legacyPool.query("SELECT request_id FROM request_decisions ORDER BY decision_sequence")).rows).toEqual([{ request_id: "a" }, { request_id: "z" }]);
      await consume(legacyPool, old.accountA.id, { userId: old.userA.id, units: 1, requestId: "new" }, { clock });
      expect((await readHistory(legacyPool, old.accountA.id, { limit: 20 })).decisions.map((row) => row.requestId)).toEqual(["new", "z", "a"]);
    } finally {
      await legacyPool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
    }
  });
});
