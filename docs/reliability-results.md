# Task 25 reliability checkpoint

Command: `npm run test:reliability` from the repository root.

Passing run: October 17, 2026, 13:54:17.563–13:54:29.373 UTC
(completion time excludes final disposable-resource cleanup).

Runtime: Node v22.22.1; PostgreSQL 17.6 (Debian 17.6-2.pgdg12+1);
Docker Compose 5.5.1. The API was built from the current workspace using the
production Dockerfile. PostgreSQL image: `postgres:17.6-bookworm`.

The run used a separate random Compose project, random localhost ports, and a
dedicated named volume. No development services were restarted or reset.

Actual runner output (no generated keys or private snapshot contents):

```text
PASS isolated stack healthy; random localhost ports and dedicated named volume
PASS meter chapter checkpoint: Tests  290 passed (290)
Baseline SHA-256 605cfa6493053a8c704c9bbd512329d9564e9d8a442423a223bd90beea094a34
PASS baseline: two accounts/users, four custom plans, edited revisions, six decisions, totals 10 and 9
PASS actual API restart: all rows/views, original keys, tenant isolation and accepted/rejected replays preserved
PASS actual PostgreSQL restart: same volume and exact data preserved; API pool reconnected without restarting API
PASS new post-recovery writes reconcile at 12 and 10; API responses/logs contain no keys, pepper or DB password
PASS cleanup: isolated containers/network/test volume removed; development stack untouched
```

The baseline's complete rows, including decision snapshots and migration history,
were compared before/after both restarts and replay checks. The digest is evidence
for this run only: new fixtures contain random identities and timestamps, so it
will differ on the next run. No fixtures were recreated between restart checks.

The full checkpoint includes validation, rule evaluation, tenant isolation,
transaction rollback, retries, concurrency, live-plan races, UTC rollover, and
nine additional failure/recovery tests. Faults cover zero/existing usage after
locking, a real SQL error after the account increment, an exception after decision
insertion, and a deferred database error at COMMIT. Each permits successful same-ID
recovery and replay using the same pooled connection. A discarded committed
response is also recovered without another charge.

An initial runner attempt exposed Docker's reassignment of random published ports
on restart. The runner was corrected to rediscover them, then the passing run above
was completed. That attempt's disposable volume was ownership-checked and removed
after the corrected verification; it contained only generated test fixtures.

Limits: controlled pre-commit faults, simulated response loss, and graceful API/DB
restarts—not hardware/power loss, arbitrary process kills, network partitions,
or throughput benchmarking. This checkpoint does not complete later endpoints,
demo/load work, or the final delivery audit.

## Shared-pepper configuration regression

Follow-up passing run: October 17, 2026, 14:37:32.389–14:37:55.258 UTC.
The original run above remains the historical Task 25 evidence.

The normal Compose API/init now use the same required `API_KEY_PEPPER` setting
as local commands, instead of a separate hardcoded value. Eight new unit checks
cover shared/missing/mismatched peppers, stale running API configuration, and
the 55432/5432 database-port mismatch. The reliability runner also checks actual
normal-Compose interpolation and rejection of an empty pepper before starting
its isolated stack.

```text
PASS normal Compose regression: api/init share the supplied pepper and empty pepper is refused
PASS meter chapter checkpoint: Tests  298 passed (298)
PASS actual API restart: all rows/views, original keys, tenant isolation and accepted/rejected replays preserved
PASS actual PostgreSQL restart: same volume and exact data preserved; API pool reconnected without restarting API
PASS new post-recovery writes reconcile at 12 and 10; API responses/logs contain no keys, pepper or DB password
PASS cleanup: isolated containers/network/test volume removed; development stack untouched
```

The corrected normal API was separately recreated without restarting PostgreSQL.
The existing account key then returned HTTP 200 for `/account` and `/plans`;
database fingerprints before/after were identical. `npm run config:check` and
`npm run db:check` both passed without printing credentials. The existing local
pepper and account records were not changed or regenerated.
