# Performance report

The saved comparison observed about **293 accepted requests/sec for one busy
account** and **1,016 across ten accounts** at concurrency 10. All 36,000 measured
actions reconciled. Separate diagnostics observed substantial account-lock
contention for the busy account. These are local measurements, not an SLA.

- [Reproduce the experiments](#reproduce-the-experiments)
- [Environment](#environment)
- [Account comparison](#account-comparison)
- [Lock diagnostics](#lock-diagnostics)
- [Correctness during plan changes](#correctness-during-plan-changes)
- [Load runner](#load-runner)

## Reproduce the experiments

Requirements: Node 22, locked dependencies installed with §npm ci§, Docker,
and Compose. Run from the repository root:

§§§bash
npm run perf:compare
npm run perf:diagnose
§§§

Both build the current API and create unique projects from
[compose.reliability.yaml](../compose.reliability.yaml), with random localhost
ports and fresh volumes. They do not load the host §.env§ or use development data.
Keys are generated at runtime and kept in memory.

The captured invocations selected these evidence directories:

§§§bash
npm run perf:compare -- --output-dir performance/results/account-comparison
npm run perf:diagnose -- --output-dir performance/results/lock-diagnostics
§§§

When repeating, omit §--output-dir§ for a unique timestamped directory or choose
a new path. Existing directories are refused. Successful runs verify resource
ownership before removing their disposable containers, network, and volume;
failed runs retain their volume for diagnosis. Raw results remain available.
Manual interruption may leave the printed test project for targeted cleanup.

## Environment

Captured runtime, machine, image, source, and database details are in the
[comparison environment](../performance/results/account-comparison/environment.json)
and [diagnostic environment](../performance/results/lock-diagnostics/environment.json).
The two experiments used separate freshly built stacks on the same machine.

| Setting | Captured value |
| --- | --- |
| Host execution | Linux x64 under WSL2 on Windows; kernel `6.18.33.2-microsoft-standard-WSL2` |
| CPU | Intel Core i7-13620H; 16 logical CPUs visible to WSL/Docker |
| Memory | 8,130,293,760 bytes (about 7.57 GiB) visible to WSL/Docker, not necessarily physical host RAM |
| Docker / Compose | Docker Desktop engine 29.8.2 / Compose 5.5.1 |
| API / generator runtime | Node v22.22.1; application 0.1.0; load runner 1.0.0 |
| PostgreSQL / pg | PostgreSQL 17.6 Debian image / pg 8.23.1 |
| API processes / pool | One `node dist/src/server.js` process; pg default maximum 10 connections (`src/db/pool.ts` does not override it) |
| DB settings | max_connections=100; shared_buffers=128MB; fsync=on; synchronous_commit=on |
| Resource isolation | No explicit per-container CPU/memory caps; client, API and DB share this machine |
| Other load | Normal development API/DB remained running; other host activity was not controlled |
| Source | HEAD `36cd2520936fa9b2dc8a25fbd09c2e23541a1bef`, **dirty=true**; includes uncommitted implementation and verification work, not a claim that HEAD alone contains this runner |

The source fields describe the dirty workspace used for each measurement;
HEAD alone does not identify all uncommitted content. No real key, digest,
private pepper, or connection URL is included in published result JSON.

## Account comparison

Captured October 18, 2026, **10:40:42.951–10:43:02.419 UTC**, including build,
fixture setup, and warmups. Each raw file records its own measured duration.

### Method

- One account with 20 users versus ten accounts with two users each.
- Exactly 2,000 new one-unit requests per measurement, distributed evenly.
- Account and user monthly limits 4,000; per-request limits 2,000.
- Concurrency 1, 10, and 50; three repetitions per shape/level:
  18 measured runs and 36,000 measured actions.
- A separate 500-request, concurrency-10 warmup per shape, excluded from summaries.
- Fresh account/user/request IDs for every run; all runs execute sequentially
  against the same API/database processes within the comparison.
- Concurrency order rotates and the second repetition reverses shape order.
- Bounded closed-loop HTTP workers, 10-second attempt timeout, no retries/redirects.

Latency uses a monotonic clock through response-body consumption. Fixture setup,
warmups, reconciliation, and waiting to claim a worker job are outside the measured
interval. Fixture creation may warm connections.

### Results

Every run recorded 2,000 accepts, zero quota rejections, zero unexpected HTTP
statuses, zero timeouts/network errors/invalid responses, and 2,000 HTTP 200s.
Account usage, sum of user usage, and unique accepted ledger units were all 2,000.

Values are medians of three run-level values; parentheses show min–max.
Percentiles are not pooled, so median latency columns may come from different runs.
The [summary](../performance/results/account-comparison/summary.json) retains
full precision and the supporting filenames.

| Shape | Workers | Requests/sec (range) | Load duration ms | p50 ms | p95 ms (range) | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 account / 20 users | 1 | 228.07 (208.33–234.73) | 8769.40 | 4.11 | 5.89 (5.47–6.73) | 8.23 |
| 1 account / 20 users | 10 | 292.65 (272.42–297.76) | 6834.18 | 32.57 | 42.92 (40.51–48.32) | 50.59 |
| 1 account / 20 users | 50 | 263.26 (237.46–267.88) | 7597.11 | 190.89 | 228.75 (222.89–264.37) | 240.93 |
| 10 accounts / 2 users each | 1 | 221.68 (209.51–234.15) | 9022.13 | 4.16 | 6.63 (5.86–7.54) | 8.50 |
| 10 accounts / 2 users each | 10 | 1015.57 (1003.93–1127.47) | 1969.33 | 9.36 | 14.15 (11.77–14.21) | 17.36 |
| 10 accounts / 2 users each | 50 | 1053.60 (920.77–1123.62) | 1898.25 | 46.01 | 56.55 (54.27–71.00) | 75.86 |

### Raw measurements

| Shape / workers | Repetition 1 | Repetition 2 | Repetition 3 |
| --- | --- | --- | --- |
| Hot / 1 | [raw](../performance/results/account-comparison/hot-c1-r1.json) | [raw](../performance/results/account-comparison/hot-c1-r2.json) | [raw](../performance/results/account-comparison/hot-c1-r3.json) |
| Hot / 10 | [raw](../performance/results/account-comparison/hot-c10-r1.json) | [raw](../performance/results/account-comparison/hot-c10-r2.json) | [raw](../performance/results/account-comparison/hot-c10-r3.json) |
| Hot / 50 | [raw](../performance/results/account-comparison/hot-c50-r1.json) | [raw](../performance/results/account-comparison/hot-c50-r2.json) | [raw](../performance/results/account-comparison/hot-c50-r3.json) |
| Many / 1 | [raw](../performance/results/account-comparison/many-c1-r1.json) | [raw](../performance/results/account-comparison/many-c1-r2.json) | [raw](../performance/results/account-comparison/many-c1-r3.json) |
| Many / 10 | [raw](../performance/results/account-comparison/many-c10-r1.json) | [raw](../performance/results/account-comparison/many-c10-r2.json) | [raw](../performance/results/account-comparison/many-c10-r3.json) |
| Many / 50 | [raw](../performance/results/account-comparison/many-c50-r1.json) | [raw](../performance/results/account-comparison/many-c50-r2.json) | [raw](../performance/results/account-comparison/many-c50-r3.json) |

Excluded warmups: [hot](../performance/results/account-comparison/warmup-hot.json)
and [many](../performance/results/account-comparison/warmup-many.json).
Each accepted 500 actions and reconciled 500 account/user/ledger units.

### Findings

At one worker, throughput ranges overlap because requests have little opportunity
to execute in parallel. At ten workers, ten independent accounts have **3.47×**
the hot account's median throughput and lower p95 latency: 14.15 versus 42.92 ms.

For one account, increasing workers from 10 to 50 reduced median throughput from
292.65 to 263.26 requests/sec while p95 rose from 42.92 to 228.75 ms.
For ten accounts, the same increase improved median throughput by about 3.7%,
with overlapping ranges, while p95 rose from 14.15 to 56.55 ms.

The implementation holds the account row lock through commit, so users sharing an
account serialize mutations. Independent accounts can overlap transactions.
At concurrency 50 the API still has ten database connections; pool waiting,
database work, HTTP handling, and lock contention may all contribute to latency.
The uninstrumented comparison does not isolate their individual costs.

## Lock diagnostics

Captured October 18, 2026, **12:43:11.818–12:43:56.118 UTC**, including setup.
The [driver](../performance/diagnose.ts) uses the same two shapes, 20 total users,
limits, 2,000 requests, and three repetitions, at concurrency 10 only.
Two separate 500-request warmups precede the six measured loads.

A separate read-only observer queries §pg_stat_activity§ and §pg_blocking_pids§,
filtered to the API's network address/application name in the test database.
The [sampler](../performance/lock-sampling.ts) identifies blocking at the account
§FOR UPDATE§ statement. It excludes fixture/observer connections and stores only
aggregate counts; query text and backend PIDs are not saved.

Sampling spans the workload, before reconciliation. Queries are sequential with
a minimum 25-ms pause; actual intervals also include query/scheduling time.
A sample counts concurrent blocked backends. Means are unweighted sample
averages, not request counts, wait durations, or time-weighted measurements.

### Observations

The [diagnostic summary](../performance/results/lock-diagnostics/summary.json)
contains full-precision aggregates; each row links its raw load and sample series.

| Shape / repetition | Samples | Mean account-lock waiters | Peak waiters | Samples with account-lock wait | Raw load / samples |
| --- | ---: | ---: | ---: | ---: | --- |
| Hot / 1 | 256 | 8.43 | 9 | 255/256 | [load](../performance/results/lock-diagnostics/hot-c10-r1.json) / [locks](../performance/results/lock-diagnostics/hot-c10-r1-locks.json) |
| Hot / 2 | 241 | 8.49 | 9 | 240/241 | [load](../performance/results/lock-diagnostics/hot-c10-r2.json) / [locks](../performance/results/lock-diagnostics/hot-c10-r2-locks.json) |
| Hot / 3 | 235 | 8.51 | 9 | 234/235 | [load](../performance/results/lock-diagnostics/hot-c10-r3.json) / [locks](../performance/results/lock-diagnostics/hot-c10-r3-locks.json) |
| Many / 1 | 66 | 0.03 | 1 | 2/66 | [load](../performance/results/lock-diagnostics/many-c10-r1.json) / [locks](../performance/results/lock-diagnostics/many-c10-r1-locks.json) |
| Many / 2 | 63 | 0.00 | 0 | 0/63 | [load](../performance/results/lock-diagnostics/many-c10-r2.json) / [locks](../performance/results/lock-diagnostics/many-c10-r2-locks.json) |
| Many / 3 | 64 | 0.03 | 1 | 2/64 | [load](../performance/results/lock-diagnostics/many-c10-r3.json) / [locks](../performance/results/lock-diagnostics/many-c10-r3-locks.json) |

Each measured load accepted 2,000, rejected zero, and had zero unexpected outcomes.
All account/user/accepted-ledger totals were 2,000: **12,000 measured actions**.
The [hot warmup](../performance/results/lock-diagnostics/warmup-hot.json)
and [many warmup](../performance/results/lock-diagnostics/warmup-many.json)
each accepted and reconciled 500, excluded from measured totals.

Every diagnostic sample saw ten API backend connections. Hot-account samples
averaged 8.43–8.51 blocked at the account-lock statement; independent accounts
averaged 0–0.03. Recorded §tuple§ and §transactionid§ events, together with the
blocking-PID check, provide direct evidence of account-row lock contention.

That contention is the strongest directly observed hot-account constraint.
The experiment does not measure pool queue durations, individual lock-wait
times, per-statement costs, or CPU/storage utilization. Short waits may fall
between samples. The observer adds work, and the diagnostic reuses a generator
process, so its timings are separate observations rather than optimization gains.

### Improvement considered

One candidate is to remove a redundant usage-read round trip while keeping the
account lock. In [usage-repository.ts](../src/modules/usage/usage-repository.ts),
§ensureUserUsageBucket§ already reads the owned bucket to validate its conflict;
§consume§ then calls §getUserUsage§ under the same lock.

Returning and reusing that validated value could shorten lock-held work, but
changes the repository contract and must preserve ownership/missing-row checks.
**No optimization or speedup was implemented or measured.** A next experiment
would measure pool/statement/lock-held time, apply the small refactor, rerun the
regression gate, and repeat the same uninstrumented comparison.

## Correctness during plan changes

[Plan-change tests](../tests/integration/plan-changes.test.ts) use real HTTP
handlers and PostgreSQL with explicit gates and observed lock waits.
These cases verify ordering and stored snapshots rather than benchmark speed.

| Case | Asserted outcome |
| --- | --- |
| Downgrade, consume-first | Usage 8/limit 10; racing 2 accepts under revision 1, then limit becomes 5. Usage stays 10 and fresh requests reject. |
| Downgrade, update-first | Limit becomes 5/revision 2 before consumption. The racing action rejects and usage stays 8. |
| Account allowance increase | Six queued 2-unit actions across two users use revision 2 after limit 10→20; totals finish account 20, users 10/10. |
| Shared user-plan increase | Six queued actions use the shared revision 2 after limit 5→10; users independently finish at 10, account 20. |
| Retry bursts during increase/downgrade | Eight valid replays preserve one original 3-unit charge; changed-user/units retries return 409 and history stays unchanged. |
| Fault while downgrade waits | A failure between increments rolls back; the waiting update completes and a same-ID retry records one rejection under the new plan. |

Independent SQL checks compare account totals, per-user totals, accepted ledger
units, decision counts, and persisted rule revisions. Gates are test-only and
have bounded waits. Replays preserve old snapshots; downgrades may leave earlier
valid usage above the new allowance, with current remaining clamped to zero.
Run them through the [full verification gate](../README.md#tests).

## Load runner

For one configurable scenario, use the existing local/test API and database.
Requirements are Node 22, §npm ci§, and a private §.env§ whose §DATABASE_URL§ and
§API_KEY_PEPPER§ match that API. The role needs fixture/verification permissions.

§§§bash
docker compose up -d --build --wait api
npm run config:check
npm run perf -- --requests 20 --concurrency 2
npm run perf -- --workload correctness --concurrency 20
npm run perf -- --help
§§§

This workflow creates fresh dedicated fixtures in the selected database and
retains them for inspection; it never resets existing accounts. The
[fixture builder](../performance/fixtures.ts) provisions keys locally, then
creates custom plans, assignments, and users through authenticated API routes.
The CLI entry is [run.ts](../performance/run.ts).

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--workload` | `throughput` | `throughput` or `correctness` |
| `--base-url` | `PERF_BASE_URL` or `http://127.0.0.1:3000` | HTTP(S) origin; paths, embedded credentials, query strings and fragments are rejected |
| `--accounts` | 1 | Fresh account count, 1–100, no more than requests |
| `--users-per-account` | 2 | Fresh users on a shared custom user-plan definition, 1–100 per account |
| `--requests` | 1000 throughput / 200 correctness | Fixed total action count, 1–100000 |
| `--concurrency` | 10 | Fixed worker count, 1–512; actual workers are capped at request count |
| `--timeout-ms` | 10000 | Timeout for each attempt, 1–120000 ms |
| `--monthly-limit` | Request count | Throughput-only account/user monthly limit, at least the request count and at most 1000000; use headroom for comparisons |
| `--output` | Unique timestamp/workload/UUID path under `performance/results/` | New `.json` result path; existing files are refused before fixture setup |

Throughput uses monthly limits equal to the total request count by default;
§--monthly-limit§ can add headroom. Both per-request limits equal request count.
The correctness workload fixes one account, 200 unique one-unit actions,
account allowance 100, and user/per-request limits 200: exactly 100 accepts
and 100 account-monthly rejections are expected.

### Measurements and reconciliation

[load.ts](../performance/load.ts) uses a fixed worker pool with round-robin
account/user selection, unique run-prefixed IDs, and no silent retries.
Each settled attempt has exactly one outcome:

| Counter | Meaning |
| --- | --- |
| accepted | HTTP 200 with a valid matching accepted decision |
| quotaRejected | HTTP 200 with a valid matching rejected decision |
| unexpectedHttpStatus | Any status other than 200 |
| timeout | Deadline exceeded, including reading the response body |
| networkError | Connection/transport failure |
| invalidResponse | Invalid JSON/decision or mismatched request ID, user, or units |

Nearest-rank p50/p95/p99 and completed/sec include all settled attempts, including
failures; accepted/sec counts accepted actions only. Received headers contribute
to the HTTP status histogram even if reading the body later times out.

[reconcile.ts](../performance/reconcile.ts) opens a separate read-only,
repeatable-read SQL snapshot and verifies:

- Account consumption = sum of user consumption = unique accepted decision units,
  per account, month, and user.
- Decision counts match observed accepts/rejections and request IDs are unique.
- Fixtures retain their expected owners, assignments, limits, and revisions.
- No fixed allowance is exceeded; each action belongs to the expected run/user.
- Throughput accepts everything; correctness has exactly 100 accepts/100 rejections.
- The run stays in one UTC month; a boundary-crossing run fails verification.

A timeout can occur after commit. The runner attempts reconciliation, marks the
run failed, and does not assume no charge occurred; in-flight work can still
settle after that snapshot. Unexpected outcomes or accounting mismatches exit 1.
Readiness/setup failures also save a failed result with no measured load.
Invalid options or an existing/unwritable output path fail without a success claim.

### Result files and saved runner checks

[report.ts](../performance/report.ts) validates versioned JSON before writing.
The [JSON schema](../performance/result.schema.json) can be regenerated to stdout:

§§§bash
node --import tsx performance/schema.ts
§§§

Results record settings, outcome/status counts, rates, latency, reconciliation,
tool/runtime versions, machine details, timestamps, and source commit/dirty
state. Existing files are never overwritten; null metadata means unavailable.
No raw keys, digests, private pepper, or database connection URL is saved.

The short runner checks were captured October 18, 2026 on a disposable stack:

| Saved result | Status | Accepted / quota rejected | Unexpected outcomes | Account / users / accepted ledger units |
| --- | --- | --- | --- | --- |
| [`runner-smoke.json`](../performance/results/runner-smoke.json) | passed | 20 / 0 | 0 | 20 / 20 / 20 |
| [`runner-correctness.json`](../performance/results/runner-correctness.json) | passed | 100 / 100 | 0 | 100 / 100 / 100 |
| [`runner-unreachable.json`](../performance/results/runner-unreachable.json) | failed as intended | No load dispatched | API readiness failed | Not measured |

Their exact captured CLI arguments were:

```bash
npm run perf -- --base-url http://127.0.0.1:32799 --requests 20 --concurrency 2 --output performance/results/runner-smoke.json
npm run perf -- --base-url http://127.0.0.1:32799 --workload correctness --requests 200 --concurrency 20 --output performance/results/runner-correctness.json
npm run perf -- --base-url http://127.0.0.1:32799 --requests 20 --concurrency 2 --timeout-ms 1000 --output performance/results/runner-unreachable.json
```

The last command ran after stopping only that disposable API and exited 1 as
expected. Port 32799 was ephemeral; use your own test origin and a new output
path when repeating. Matching database/pepper values were supplied privately.

## Limits of these findings

These are short, closed-loop local runs on shared WSL/Docker hardware. Other host
activity, fixture connection warming, JIT, cache, and storage scheduling can
influence results. Three repetitions give a limited local comparison.
They establish neither production capacity nor sustained-load behavior, a latency
SLA, an optimal worker/pool size, or a complete breakdown of transaction costs.

The comparison retains all 18 measurements and both warmups; diagnostics retain
six loads, their samples, and two warmups. No failed measurement was discarded
to improve the tables. Successful runs checked accounting and redaction before
removing their own resources. The [README](../README.md#tests) records the full
regression command and workspace verification summary.
