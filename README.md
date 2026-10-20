# Usage Metering and Quota Service

A TypeScript HTTP API that meters **document-processing units** and enforces
shared account quotas and individual user quotas. PostgreSQL persists accounts,
plans, assignments, monthly usage, and accepted/rejected decisions.

- [Quick start](#quick-start)
- [Example client](#example-client-walkthrough)
- [Try the API](#try-the-api)
- [Behavior and design](#behavior-and-design)
- [Architecture and data model](#architecture-and-data-model)
- [Tests](#tests)
- [Performance](#performance)
- [Configuration and troubleshooting](#configuration-and-troubleshooting)

The detailed references are [API](docs/api.md) and [performance](docs/performance.md).

## Quick start

Prerequisites: Docker Engine/Desktop running with Docker Compose v2+ and Linux
containers; curl 7.76+ for host HTTP checks. On Windows, WSL2/Ubuntu is the supported
shell for the Bash examples and host verification scripts. Run commands from the repository root.

1. Copy the example configuration once; do not overwrite an existing private file.

   ```bash
   cp .env.example .env
   ```

   In `.env`, replace `API_KEY_PEPPER` with a private random value of at least
   16 characters. Keep it stable after issuing keys. For example, generate one
   locally with the pinned image (keep the output private):

   ```bash
   docker run --rm node:22.22.1-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   The provided database password/URL are **local-demo credentials**, not production
   secrets or a secure deployment configuration. Never commit `.env` or issued keys.
   PowerShell users can use `Copy-Item .env.example .env` for the copy step.

2. Start everything with the required full-stack command:

   ```bash
   docker compose up --build
   ```

   Startup order is database healthy → migrations/seeds finish → API healthy →
   demo. The demo creates a fresh account/key in memory, demonstrates acceptance,
   user/account rejection, a plan update and an immutable retry, then prints
   `Demo completed successfully.` and exits **0**. `init` also exits 0 normally;
   `api` and `db` keep running. There is no browser UI: the example is a CLI client.

3. In a second terminal:

   ```bash
   docker compose ps --all
   docker compose logs demo
   curl --fail-with-body http://localhost:3000/health
   ```

   Health returns `{"status":"ok","database":"reachable"}` with HTTP 200.
   The default example finishes at account **31 consumed / 19 remaining**;
   Premium has **27 / 3**. [Scenario details](#example-client-walkthrough).

For background operation, `docker compose up -d --build` is the alternative;
still check `docker compose ps --all` and demo logs for its successful exit.
To run another **fresh** example without resetting data:

```bash
docker compose run --rm demo
```

Use `docker compose down` then `docker compose up --build` to recreate containers
with the same volume. Keep the project name and pepper stable to preserve working
keys. `down --volumes` intentionally deletes the database, history, and retry
protection. Ctrl+C stops foreground services; another `up` starts them again.

## Example client walkthrough

The client is a separate HTTP caller, not a browser frontend. It creates its
plans/users through the authenticated API and checks the returned decisions and
balances. Only initial account/key provisioning uses operator database access.

The demo creates one account and two users with these custom plans:

| Plan | Scope | Monthly allowance | Per-request cap |
| --- | --- | ---: | ---: |
| Demo Account | Account | 30, later raised to 50 | 100 |
| Demo Basic | User | 10 | 5 |
| Demo Premium | User | 30 | 20 |

| Action | Decision | Account consumed / remaining | Relevant user consumed / remaining |
| --- | --- | --- | --- |
| Basic requests 4 | Accepted | 4 / 26 | Basic: 4 / 6 |
| Basic requests 6 | Rejected: user request cap 5 | 4 / 26 | Basic: 4 / 6 |
| Premium requests 20 | Accepted | 24 / 6 | Premium: 20 / 10 |
| Premium requests 7 | Rejected: account monthly cap 30 | 24 / 6 | Premium: 20 / 10 |
| Raise account limit to 50; Premium requests 7 with a new ID | Accepted | 31 / 19 | Premium: 27 / 3 |
| Retry the earlier rejected ID | Original rejection replayed | Snapshot: 24 / 6 | Snapshot: Premium 20 / 10 |

The final retry does not undo the upgrade or change usage: it returns an old
decision. A separate live usage query still shows account **31 / 19** and
Premium **27 / 3**. Five new actions produce five history entries; the replay
does not produce a sixth. See the [captured client output](demo/transcript.txt);
timestamps and the UTC month naturally change between runs.

The client simulates document processing only for accepted actions and skips
work on its explicit replay step.

### Optional host execution

The Compose demo keeps its key in memory and requires no host Node installation.
For host development, use Node 22, run `npm ci`, and configure your private `.env`:

```bash
docker compose up -d --build --wait api
npm run config:check
npm run demo:setup
npm run demo:run
```

Setup writes the ignored, owner-readable `demo/.demo.env` with the service URL,
issued key, custom account-plan ID, and both user IDs. Repeat **both** setup and
run for a fresh walkthrough; replaying an accepted quota decision does not
deduplicate a separate application's document-processing side effects.

## Try the API

Use **Bash, curl 7.76+** (`--fail-with-body`) and **Node 22** for these copy-paste
examples. Keep the following blocks in the same terminal. They create a dedicated
account and do not modify the Compose demo's account.

### 1. Obtain your own account key

With the stack running, use the operator-only CLI inside the API container:

```bash
docker compose exec -T api node dist/scripts/create-account.js --name "Reviewer account"
```

It creates an account on Starter and reveals its raw `umq_...` key **once**.
Save it privately; do not share terminal captures or paste it into tracked files.
The API never returns that key again. It is **not** the server's `API_KEY_PEPPER`.

Read the issued key into your current Bash session without putting it in history:

```bash
read -r -s -p "Issued account key: " API_KEY
printf '\n'
export API_KEY
```

The API below derives ownership solely from this key. Do not send `accountId`.
These helper functions keep the examples short; `json_field` uses Node, not jq.

```bash
BASE_URL="${BASE_URL:-http://localhost:3000}"
: "${API_KEY:?Set the one-time account key first}"

api() {
  local path="$1"
  shift
  curl --fail-with-body --silent --show-error "$BASE_URL$path" \
    -H "X-API-Key: $API_KEY" "$@"
}
json_field() {
  node -e 'let v=JSON.parse(require("node:fs").readFileSync(0,"utf8")); for(const k of process.argv[1].split(".")) v=v[k]; if(v==null) throw Error("Missing JSON field"); process.stdout.write(String(v));' "$1"
}
api /account
```

### 2. Create, assign and inspect plans/users

Custom plans belong to the authenticated account. Use returned IDs rather than
assuming auto-increment values; account/user IDs are UUIDs and plan IDs are integers.

```bash
ACCOUNT_PLAN_ID=$(api /plans -X POST -H "Content-Type: application/json" \
  -d '{"name":"Reviewer account plan","scope":"account","monthlyLimit":30,"requestLimit":100}' | json_field plan.id)
USER_PLAN_ID=$(api /plans -X POST -H "Content-Type: application/json" \
  -d '{"name":"Reviewer user plan","scope":"user","monthlyLimit":10,"requestLimit":5}' | json_field plan.id)

api /account/plan -X PATCH -H "Content-Type: application/json" \
  -d "{\"planId\":$ACCOUNT_PLAN_ID}"
USER_ID=$(api /users -X POST -H "Content-Type: application/json" -d '{}' | json_field user.id)
api "/users/$USER_ID/plan" -X PATCH -H "Content-Type: application/json" \
  -d "{\"planId\":$USER_PLAN_ID}"

api "/users/$USER_ID"
api "/plans?scope=user"
api "/plans/$ACCOUNT_PLAN_ID"
api /account/rules
api "/users/$USER_ID/rules"
```

User creation defaults to Basic when `planId` is omitted. Supplying
`{"planId":RETURNED_USER_PLAN_ID}` during creation is also supported.
Sharing a user-plan definition does **not** share those users' usage counters.

### 3. Consume, reject, change a plan and retry

```bash
FIRST_JSON=$(api /consume -X POST -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":4,\"requestId\":\"review-accepted-1\"}")
printf '%s\n' "$FIRST_JSON"

# Valid retry: identical original response, no second charge.
REPLAY_JSON=$(api /consume -X POST -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":4,\"requestId\":\"review-accepted-1\"}")
node -e 'require("node:assert/strict").deepEqual(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]));' "$FIRST_JSON" "$REPLAY_JSON"

# Quota rejection is HTTP 200; user per-request cap is 5.
api /consume -X POST -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":6,\"requestId\":\"review-rejected-2\"}"

api "/plans/$ACCOUNT_PLAN_ID" -X PATCH -H "Content-Type: application/json" \
  -d '{"monthlyLimit":50}'
api "/plans/$USER_PLAN_ID" -X PATCH -H "Content-Type: application/json" \
  -d '{"requestLimit":10}'

# Same rejected ID remains rejected under its original rules.
api /consume -X POST -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":6,\"requestId\":\"review-rejected-2\"}"

# A NEW ID evaluates the new rules and accepts 6.
api /consume -X POST -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":6,\"requestId\":\"review-new-3\"}"
```

Expected sequence: accept 4 → replay that acceptance → reject 6 by the user
per-request rule → update both plans → replay the original rejection → accept
6 with a new ID. Final live usage is account **10 / 40 remaining**, user
**10 / 0 remaining**. There are exactly **three** history decisions, not five.
A response contains `accepted`, `blockedBy`, `requestId`, `userId`, `units`,
`processedAt`, `month`, and account/user balances with applied plan IDs/revisions.
[Full response examples](docs/api.md#consumption-contract).

### 4. Read current/past usage and page history

```bash
api /usage
api "/users/$USER_ID/usage"
PREVIOUS_MONTH=$(node -e 'const d=new Date(); console.log(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-1,1)).toISOString().slice(0,7))')
api "/usage?month=$PREVIOUS_MONTH"
api "/users/$USER_ID/usage?month=$PREVIOUS_MONTH"

PAGE=$(api "/history?limit=1&userId=$USER_ID")
printf '%s\n' "$PAGE"
CURSOR=$(printf '%s' "$PAGE" | json_field nextCursor)
api "/history?limit=1&userId=$USER_ID&cursor=$CURSOR"
```

This fixture has zero usage in the previous month. Noncurrent usage contains
consumption only; history retains original rules and balances. Continue with
`nextCursor` and the same user/month filters until it is `null`. Later inserts
stay outside that cursor session. Repeat the walkthrough with fresh accounts/IDs.

## Behavior and design

### Accounting and plans

An account represents a calling company/application; each user belongs to one
account. Plans define monthly and per-request limits at account or user scope.

```text
account monthly consumption = sum of user consumption = accepted decision units
```

An accepted 4-unit action adds 4 to its user and account totals. Rejection changes
neither. Both monthly allowances and both per-request caps must permit an action.
The first blocker is checked in this order: account per-request, user per-request,
account monthly, then user monthly. Exact boundaries are accepted.

| Predefined plan | Scope | Monthly allowance | Per-request cap |
| --- | --- | ---: | ---: |
| Starter (ID 1) | Account | 10000 | 100 |
| Pro (ID 2) | Account | 100000 | 1000 |
| Basic (ID 3) | User | 1000 | 20 |
| Premium (ID 4) | User | 10000 | 100 |

Startup inserts missing defaults without overwriting existing rows.
Predefined plans are read-only. Custom plans belong to one account and must match
the assignment's scope. Users sharing a plan still have independent usage.
Edits affect every assigned user's new requests. Switches and edits preserve
consumption and old decisions; remaining is `max(0, monthlyLimit - consumed)`.

### Atomicity, concurrency, and UTC months

One READ COMMITTED transaction on one checked-out connection locks the account
with a standalone `SELECT ... FOR UPDATE` before reading mutable rules.
Consumption, custom-plan mutations, user creation, and assignment changes
cooperate with that account-first lock order. Independent accounts can proceed
concurrently; requests sharing an account serialize.

A new consumption checks the owned user and any saved request ID, reads fresh
assignments/plans, and captures PostgreSQL `statement_timestamp()` after the lock.
It evaluates all rules, increments both counters on acceptance, inserts the
decision, and commits before returning. Errors roll back all writes and release
the connection. A plan update that commits before a waiting request acquires the
lock is visible to that request.

The captured instant determines one UTC calendar month for both counters and
the decision. A request queued in October but processed after the lock in
November uses November. New months create separate buckets; old rows remain.
Current usage/rule reads share one SQL statement snapshot for plans and counters.

### Retry and history policy

Request IDs are case-sensitive and unique per account across users and months.

- Same ID and normalized user/units returns the original accepted or rejected
  response, without another charge or history row.
- Same ID with different user/units returns 409. Other accounts may reuse the ID.
- Plan edits, switches, restarts, and month rollover preserve saved outcomes.
  Replayed balances are historical; use usage routes for current counters.
- After an uncertain response, retry the same ID/payload. After a plan change,
  use a new ID for a new decision.
- Valid rejections enter history. Authentication, validation, missing-user, and
  conflict errors do not create consumption decisions.

History uses descending immutable BIGINT sequences, returned as decimal strings.
A cursor fixes an upper bound and advances below the last entry, so later
insertions do not shift continuation pages. Retain its user/month filters.
Decision history and retry IDs have no TTL or automatic pruning.

Units are integers 1–2,147,483,647; limits are integers 0–2,147,483,647.
Zero is a valid deny-all limit. PostgreSQL integer values round-trip exactly as
JavaScript numbers; quantity validation rejects strings, fractions, and overflow.

All tenant routes require `X-API-Key`. The account comes only from authentication;
foreign resources return the same 404 as missing resources. API keys contain
32 random bytes; only an HMAC-SHA-256 digest is stored. The pepper stays private.

| Status | Meaning |
| --- | --- |
| 200 / 201 | Successful operation or quota decision / created user or plan |
| 400 / 401 | Invalid input / missing or invalid key |
| 403 / 404 | Read-only predefined plan / missing or foreign resource |
| 409 / 422 | Request-ID payload conflict / incompatible plan scope |
| 413 / 415 | Body over 1 MiB / unsupported content type |
| 500 / 503 | Unexpected failure / database-unavailable health response |

Errors contain `error.code`, `error.message`, and a server `correlationId`.
Quota rejection is HTTP 200 with `accepted: false` and `blockedBy`.
Noncurrent-month usage exposes consumption only; historical limits remain in
saved decisions. Full formats and validation rules are in the [API reference](docs/api.md).

## Architecture and data model

```text
CLI / HTTP client → Fastify → domain rules + account-locked SQL → PostgreSQL
```

Strict TypeScript checks code; Zod validates runtime JSON; pg uses parameterized SQL.

### Trace a consumption request

For `POST /consume`, follow these functions in order:

1. [createAuthenticateApiKeyHook](src/middleware/authenticate-api-key.ts) validates
   the header key and resolves its account through `createApiKeyAuthenticator`.
2. [registerConsumptionRoutes](src/modules/usage/routes.ts) validates the body and
   calls [consume](src/modules/usage/consume.ts) with the authenticated account ID.
3. [withLockedAccountTransaction](src/db/account-transaction.ts) starts a
   READ COMMITTED transaction and locks that account before mutable rule reads.
4. `consume` checks user ownership and the saved request ID. An identical retry
   returns its original decision; a changed payload raises a conflict.
5. For a new ID, `consume` reads current plans and captures the UTC processing
   month, then [evaluateRules](src/modules/usage/evaluate-rules.ts) checks both
   per-request caps and both monthly allowances.
6. An acceptance updates both counters through the
   [usage repository](src/modules/usage/usage-repository.ts). Both accepted and
   rejected decisions are saved by `consume` with their original rule/balance
   snapshots; a rejection leaves consumption unchanged.
7. `withLockedAccountTransaction` commits before the route sends the decision.
   Any transaction failure rolls back its writes and releases the connection.

### Database tables

| Table | Responsibility / key |
| --- | --- |
| accounts | Account identity, unique key digest, account-plan assignment; UUID ID |
| users | Account ownership and user-plan assignment; UUID ID |
| plans | Predefined or owned definitions, account/user scope and revision; integer ID |
| account_monthly_usage | One counter per (account, UTC month) |
| user_monthly_usage | One counter per (user, UTC month), tied to its owning account |
| request_decisions | Outcome, original rule/balance snapshot; unique (account, request ID) |
| schema_migrations | Applied SQL filenames and timestamps |

Composite user/account foreign keys prevent cross-account usage and decision
rows. Unique keys prevent duplicate buckets and request IDs; SQL checks enforce
numeric ranges, scopes, and first-day-of-month keys. Application services enforce
eligible plan ownership/scope, predefined-plan immutability, and atomic accounting.
Direct SQL access can bypass application-only rules.

The [SQL migrations](src/db/migrations/) define exact columns and indexes.
Migration bookkeeping is committed with each migration; repeated runs skip
applied files. A decision stores plan IDs/revisions, processing time/month,
outcome, blocker, original balances, and evaluated limits.

| Directory | Purpose |
| --- | --- |
| src/ | HTTP/auth/error handling, accounts/users/plans/usage, database and validation |
| scripts/ | Operator commands, configuration diagnosis, isolated verification |
| demo/ | Runnable client, fixture setup, captured transcript |
| tests/ | Unit, PostgreSQL integration, and concurrency tests |
| performance/ | Load tools, diagnostic scripts, result schema and measured evidence |
| docs/ | API reference and performance report |

Containers pin Node **22.22.1** and PostgreSQL **17.6-bookworm**; host Node is
major 22 via `.nvmrc`. Use `npm ci` with the committed lockfile.
The measured stack uses Fastify 5.12.5, pg 8.23.1, Zod 4.6.6,
TypeScript 7.0.2, tsx 4.23.15, and Vitest 5.0.3.

## Tests

With Node 22, installed dependencies, and Docker running:

```bash
npm ci
npm run verify
```

The gate runs typecheck, production build, all existing tests against disposable
PostgreSQL, actual API/database restarts, and default Compose demo/recreation.
No development API/database or manual migrations are needed. It stops at the
first failure and redacts credentials from child output.

| Coverage | Existing evidence |
| --- | --- |
| Four rules, boundaries, invalid units, zero limits and overflow | [Evaluator tests](tests/unit/evaluate-rules.test.ts), [consume tests](tests/integration/consume.test.ts) |
| Authentication and two-account isolation across tenant routes | [Tenant matrix](tests/integration/tenant-matrix.test.ts) |
| Replay, payload conflicts, last-unit and duplicate-request races | [Idempotency tests](tests/integration/idempotency.test.ts), [concurrency tests](tests/concurrency/last-units.test.ts) |
| Live plan edits/switches and both controlled update/consume orders | [Plan-change tests](tests/integration/plan-changes.test.ts) |
| UTC rollover, historical reads and stable pagination | [Month tests](tests/integration/month-rollover.test.ts), [history tests](tests/integration/history.test.ts) |
| Rollback faults and lost committed responses | [Recovery tests](tests/integration/failure-recovery.test.ts) |
| Real API/database restarts and reconciling new writes | [Reliability runner](scripts/verify-reliability.ts) |
| Fresh Compose demo and retained-volume recreation | [Compose runner](scripts/verify-compose-demo.ts) |

Each gate uses uniquely named Compose projects, random localhost ports, fresh
volumes, and per-suite schemas/databases. Successful cleanup verifies ownership
before removing only disposable resources; failed runs retain diagnostic volumes.
Tests require schema/database creation privileges on that disposable server.

For a reproducible shuffle order, use `VERIFY_TEST_SEED=411 npm run verify`.
Focused `npm test`/Vitest runs should explicitly select a disposable
`TEST_DATABASE_URL`. The concurrency suite also needs CREATEDB.
`npm run typecheck` and `npm run build` can be run separately.

The latest `npm run verify` passed on October 20, 2026, with shuffle seed
`858541562`: typecheck, production build, **439 tests**, actual API/PostgreSQL
restarts, default Compose demo startup, and retained-data checks. This run used
the local workspace based on `d27aeea`, including the uncommitted localhost-only
PostgreSQL binding and usage-read refactor, with disposable Docker stacks.
Controlled faults and graceful restarts do not simulate every hardware failure,
network partition, or availability condition.

## Performance

```bash
npm run perf:compare
npm run perf:diagnose
```

These commands create isolated stacks and retain measured JSON evidence.
The [performance report](docs/performance.md) contains reproduction settings,
environment, raw links, lock diagnostics, correctness checks, and limitations.
At concurrency 10 the saved comparison observed median ~293 accepted
requests/sec for one busy account and ~1016 across ten accounts.

For a small run against an explicitly configured local test API/database:
`npm run perf -- --requests 20 --concurrency 2`. This workflow reads the
private environment and retains its newly provisioned fixtures in that database.

## Configuration and troubleshooting

| Setting | Purpose |
| --- | --- |
| API_KEY_PEPPER | Private stable secret, at least 16 characters; shared by API/init/demo and host provisioning |
| API_PORT | Published API port, default 3000; internal API stays api:3000 |
| POSTGRES_PORT | DB port published on 127.0.0.1 only; .env.example selects 55432, Compose fallback is 5432 |
| DATABASE_URL | Host DB connection; match the published DB port |
| HOST / PORT / NODE_ENV | Host server options; defaults 0.0.0.0 / 3000 / development |
| DEMO_SERVICE_URL / PERF_BASE_URL | Optional host demo/load API origin |

Compose injects the internal `db:5432` URL. Exported shell variables override
`.env`; keep host database/client addresses aligned with published ports.

| Symptom | Check |
| --- | --- |
| Port occupied | Select unused API_PORT/POSTGRES_PORT and align DATABASE_URL/client origin |
| Unexpected 401 | Use the issued account key, keep the original pepper, run npm run config:check |
| Container settings changed | Recreate with docker compose up -d --no-deps --wait api; restart alone retains old environment |
| init/demo exited 0 | Expected one-shot completion; api/db should remain healthy |
| Health 503 | Inspect local database readiness/connectivity |

For host development, `npm run dev` watches source; `npm run build && npm start`
runs compiled code. Operator commands are `db:init`, `db:migrate`, `db:seed`,
`db:check` (after a build), and `account:create -- --name "Example"`,
all invoked through `npm run` against the explicitly configured database.
Account creation defaults to Starter; `--plan Pro` selects Pro.

## Scope and limitations

The required scope covers the quota service, account isolation, plans, durable
usage/history, live updates, safe retries, concurrency, client, tests, and
performance evidence. Fastify, CLI provisioning, UTC processing months,
first-blocker precedence, and historical-usage conventions are chosen decisions.

Per-account serialization limits a hot account's throughput. One Node process,
a ten-connection default pool, and shared local hardware also constrain scaling.
History grows without retention. Billing, refunds, end-user login, multiple
resources, RBAC, distributed infrastructure, and a browser UI are outside scope.
Production TLS, secret management, key rotation/revocation, and deployment
hardening are not implemented. The API does not atomically coordinate an
external document processor. SIGINT/SIGTERM close the HTTP server and pool.

## ChatGPT assistance

All testing and performance-related work, including automated tests, verification
scripts, benchmarking tools, and performance analysis/documentation, was developed
with assistance from ChatGPT. Reported outcomes come from actual local runs;
raw performance results are included in this repository.
