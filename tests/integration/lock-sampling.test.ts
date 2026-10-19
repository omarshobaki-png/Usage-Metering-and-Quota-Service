import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { readLockCounts, summarizeLocks } from "../../performance/lock-sampling.js";
import { runMigrations } from "../../src/db/migrate.js";
import { seedPredefinedPlans } from "../../src/db/seed.js";
import { provisionAccount } from "../../src/modules/accounts/provision-account.js";

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (connectionString === undefined) throw new Error("A disposable database URL is required.");
const name = `lock_observer_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString, max: 1, application_name: `${name}_observer` });
const contenders = new Pool({ connectionString, max: 2, application_name: name,
  options: `-c search_path=${name} -c statement_timeout=8000 -c lock_timeout=6000` });

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${name}"`);
  await runMigrations(contenders);
  await seedPredefinedPlans(contenders);
});
afterAll(async () => {
  await contenders.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  await admin.end();
});

it("identifies an actual account FOR UPDATE waiter, excludes the observer, and sees lock release", async () => {
  const account = await provisionAccount(contenders, { name: "Lock sample fixture", apiKeyPepper: "lock-observer-test-pepper" });
  const holder = await contenders.connect();
  const waiter = await contenders.connect();
  let pending: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
  try {
    const address = (await holder.query<{ address: string }>("SELECT inet_client_addr()::text AS address")).rows[0]!.address;
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [account.id]);
    pending = Promise.allSettled([waiter.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [account.id])]);
    const deadline = Date.now() + 3000;
    let sample = await readLockCounts(admin, address, name);
    while (sample.accountLockWaiting !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sample = await readLockCounts(admin, address, name);
    }
    expect(sample).toMatchObject({ backends: 2, active: 1, lockWaiting: 1, accountLockWaiting: 1 });
    expect(summarizeLocks([{ ...sample, elapsedMs: 1 }]).peakAccountLockWaiting).toBe(1);
    expect(await readLockCounts(admin, address, `${name}_not_api`)).toEqual({ backends: 0, active: 0, lockWaiting: 0, accountLockWaiting: 0, lockEvents: {} });
    await holder.query("ROLLBACK");
    expect((await pending)[0]?.status).toBe("fulfilled");
    expect(await readLockCounts(admin, address, name)).toMatchObject({ lockWaiting: 0, accountLockWaiting: 0 });
    expect(JSON.stringify(sample)).not.toContain(account.apiKey);
  } finally {
    try { await holder.query("ROLLBACK"); } finally {
      holder.release(); await pending; waiter.release();
    }
  }
}, 15000);
