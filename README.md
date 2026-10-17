# Usage Metering and Quota Service

A TypeScript and PostgreSQL service that records usage and enforces account-level and user-level quotas.

## Project status

The strict TypeScript workspace, Dockerized PostgreSQL/API foundation, initial database schema, automatic predefined-plan setup, secure account provisioning, persistent API-key authentication, tenant-isolated user routes, strict request validation, account-owned custom-plan management, safe account/user plan assignment, and the stable consumption API contract are in place. The quota evaluator and database-backed consumption transaction, usage/history routes, completed demo client, and performance scenarios will be added in the next milestones.

## Development setup

Use Node.js 22 LTS. The repository pins that major version in `.nvmrc` and `package.json` and includes `package-lock.json` for reproducible installs.

```bash
nvm use
npm ci
cp .env.example .env
```

Replace the placeholder values in `.env` for your local environment. `DATABASE_URL` is required; startup fails with a `ConfigurationError` that identifies the missing setting. Set `API_KEY_PEPPER` to a private random value of at least 16 characters before provisioning accounts, and keep the same value so later API-key authentication can reproduce stored digests.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript server in watch mode during development. |
| `npm run typecheck` | Check the source with strict TypeScript without emitting files. |
| `npm run build` | Compile the project into `dist/`. |
| `npm start` | Run the compiled server. |
| `npm run db:check` | Run the compiled bounded PostgreSQL `SELECT 1` diagnostic. |
| `npm run db:migrate` | Apply pending PostgreSQL migrations. |
| `npm run db:seed` | Insert any missing predefined plans without changing existing rows. |
| `npm run db:init` | Apply migrations and then seed predefined plans. |
| `npm run account:create -- --name "Example Company"` | Create an account on Starter and reveal its API key once. |
| `npm test` | Run the automated test suite once. |
| `npm run test:watch` | Re-run tests as files change. |

The schema, seed, and account-provisioning integration tests require `TEST_DATABASE_URL` (or `DATABASE_URL`) to point to a disposable PostgreSQL database where the configured user may create and drop isolated schemas. For example:

```bash
TEST_DATABASE_URL=postgres://usage_metering:usage_metering_dev@localhost:5432/usage_metering npm test
```

Each integration suite uses a unique temporary schema and removes only that schema when it finishes.

## Docker Compose and PostgreSQL

Start the current API and PostgreSQL stack with:

```bash
docker compose up --build
```

Compose exposes the API on `http://localhost:3000` and PostgreSQL on `localhost:5432` by default. Set `API_PORT` or `POSTGRES_PORT` before starting Compose if either host port is already occupied.

The database uses the named `postgres_data` volume. PostgreSQL must pass its `pg_isready` health check before Compose runs the one-time `init` service. That service applies migrations and inserts missing predefined plans. The API starts only after initialization succeeds, then performs its own bounded `SELECT 1` readiness check before listening. Compose checks the API's `GET /health` route and marks the API healthy only when that route returns a successful response.

Inside Compose, the API connects to `db:5432` because `db` is the database service name. `localhost` inside the API container would refer to the API container itself. The `.env.example` URL uses `localhost:5432` because it is intended for commands run directly on the host machine.

In another terminal, inspect readiness and run the diagnostic:

```bash
docker compose ps
curl http://localhost:3000/health
docker compose run --rm api npm run db:check
```

When the database is reachable, the health request returns `200` with `{ "status": "ok", "database": "reachable" }`. If the running API loses its database connection, the same route returns `503` with a safe JSON error instead of exposing database details. The diagnostic succeeds with `Database connection successful: SELECT 1 returned 1.` It retries five times before returning a clear failure, so it cannot wait forever.

Run `npm run db:init` outside Compose to apply the SQL files in `src/db/migrations` and insert any missing predefined plans. Applied filenames are recorded in `schema_migrations`, and each predefined plan has a fixed integer ID, so repeating initialization creates no duplicate plans and does not overwrite existing rows. Account and user IDs remain UUIDs, while plan IDs and the columns that reference them use integers. Quantities use PostgreSQL `integer` values bounded at `2,147,483,647`; `pg` returns this type as an exact JavaScript number without a custom parser.

### Predefined plans

| Plan | Scope | Monthly limit | Maximum per request |
| --- | --- | ---: | ---: |
| Starter | Account | 10,000 | 100 |
| Pro | Account | 100,000 | 1,000 |
| Basic | User | 1,000 | 20 |
| Premium | User | 10,000 | 100 |

These four definitions are global plans, represented by rows whose `owner_account_id` is `NULL`. Normal startup inserts a missing definition but never updates an existing plan, assignment, usage row, or decision. A deliberate future change to a predefined plan should be made through a migration rather than by silently resetting seed data.

### Provision an account and issue its API key

Account provisioning is an operator command rather than a public HTTP endpoint. Initialize the database, configure `DATABASE_URL` and `API_KEY_PEPPER` in the untracked `.env` file, then run:

```bash
npm run account:create -- --name "Example Company"
```

Starter is the default account plan. Select another predefined account plan explicitly with `--plan`:

```bash
npm run account:create -- --name "Example Company" --plan Pro
```

The command generates 32 cryptographically random bytes, encodes them in a header-safe `umq_...` key, and reveals that raw key once. PostgreSQL stores only an HMAC-SHA-256 digest created with `API_KEY_PEPPER`. Save the displayed key in an untracked secret store and later supply it to clients through environment configuration; do not put it in source files, command output captures, or normal application logs. Losing the raw key requires issuing a replacement in a future key-rotation flow because the digest cannot recover it.

Provisioning validates the selected plan and inserts the account plus its initial plan assignment in one transaction. `Starter` and `Pro` are valid; `Basic` and `Premium` are user-scope plans and are rejected without leaving a partial account. Ordinary API and database restarts do not recreate accounts or rotate keys.

### Account-owned users

The user data layer creates opaque UUID-based users that always belong to one account and have one eligible user-scope plan. Basic is the default; Premium or an account-owned custom user plan may be selected explicitly. Account-scope plans and custom plans owned by another account are rejected without leaving partial rows.

User mutations begin a transaction, lock the owning account row first with `SELECT ... FOR UPDATE`, validate the plan in a later statement, write the user, and then commit. Failure paths roll back and always release the checked-out connection. This account-first order is shared infrastructure for later assignment and quota mutations.

Every lookup requires both `accountId` and `userId`, so asking account A for an account B user returns not found. The public data representation contains the user ID, owning account ID, creation time, and current plan summary. This project does not currently use user display names. API-key digests and internal SQL details are never part of a user result. HTTP authentication and user routes are added in later tasks.

### Data integrity enforcement

PostgreSQL constraints protect structural invariants even if application code contains a bug:

- primary and foreign keys require referenced accounts, users, and plans to exist;
- `(account_id, request_id)` uniquely identifies a consumption decision within one account while allowing another account to reuse the same request ID;
- composite account/user foreign keys prevent usage and decision rows from connecting one account to another account's user;
- checks restrict plan scope to `account` or `user`, require non-negative limits and usage, require positive requested units, and bound quantities at `2,147,483,647`;
- usage rows are unique by subject and UTC month, and stored month values must be the first day of that month;
- API-key digests are unique, while plan and decision references cannot be removed when protected historical or assignment rows still depend on them.

Some ownership and ordering rules need transactional application checks because a normal foreign key proves only that a plan exists:

- an account may receive only an account-scope predefined plan or an eligible custom account plan;
- a user may receive only a user-scope predefined plan or a custom user plan owned by the same account;
- account-scoped reads include `accountId` in the query so another account's resource is returned as not found;
- mutations lock the account row first with `SELECT ... FOR UPDATE`, then read current plans and usage in later statements before writing;
- later quota transactions must update account usage, user usage, and the immutable decision together, so acceptance changes both totals and rejection changes neither;
- plan changes must preserve accumulated subject usage and historical decision snapshots.

Usage belongs to the account or user rather than to the assigned plan. Multiple users may therefore share one plan definition while keeping separate monthly usage rows, and changing a plan never transfers, merges, or resets their consumed units.

To verify that the named volume preserves data across an ordinary database restart, create a temporary probe row, restart PostgreSQL, read the row, and remove the probe:

```bash
docker compose exec -T db psql -U usage_metering -d usage_metering -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS persistence_probe (message text NOT NULL); TRUNCATE persistence_probe; INSERT INTO persistence_probe VALUES ('database survived');"
docker compose restart db
docker compose up -d --wait db
docker compose exec -T db psql -U usage_metering -d usage_metering -c "SELECT message FROM persistence_probe;"
docker compose exec -T db psql -U usage_metering -d usage_metering -c "DROP TABLE persistence_probe;"
```

`docker compose down` removes the containers but preserves the named volume. `docker compose down --volumes` intentionally deletes that database volume and its data.

`docker compose up --build` now starts PostgreSQL, completes migrations and predefined-plan setup, and starts the API. The runnable example client will be added later.

### HTTP request handling

JSON request bodies are limited to 1 MiB (1,048,576 bytes). Unknown routes return a JSON `404` response, malformed JSON returns JSON with status `400`, and oversized bodies return JSON with status `413`. Unexpected failures return a generic JSON `500` response without exposing stack traces, SQL statements, connection strings, or other internal details.

`GET /health` is public. Tenant routes require the raw key issued by the account-provisioning command in the `X-API-Key` header. For example:

```bash
API_KEY='replace-with-the-one-time-issued-key'
curl http://localhost:3000/account -H "X-API-Key: ${API_KEY}"
```

`GET /account` returns the authenticated account ID, name, and current account-plan summary. Account identity comes only from the API key; an `accountId` supplied in a query string cannot override it. Missing, empty, malformed, and unknown keys all receive the same generic `401 Unauthorized` response. Raw keys and stored digests are never returned. The server computes the key's HMAC-SHA-256 digest using `API_KEY_PEPPER` and looks up the persisted account, so issued keys continue working across normal API restarts as long as the database and pepper are preserved.

Authenticated accounts can create and read their users:

```bash
curl -X POST http://localhost:3000/users \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}'

curl http://localhost:3000/users/replace-with-user-id \
  -H "X-API-Key: ${API_KEY}"
```

`POST /users` creates the user under the account authenticated by the key and defaults to Basic. An optional positive integer `planId` may select an eligible user plan. Mutation bodies reject unknown fields, so a caller-supplied `accountId` receives `400 INVALID_REQUEST` and cannot change ownership. `GET /users/:id` always queries with both the authenticated account ID and user ID. A foreign user and a nonexistent user therefore return the same `404 USER_NOT_FOUND` response without revealing whether another account owns the ID.

Detailed payload rules and safe error examples are documented in [`docs/api.md`](docs/api.md).

### Tenant-isolation coverage

| Tenant route area | Current evidence |
| --- | --- |
| Account inspection | Authenticated key-to-account tests |
| User creation and reads | Two-account create/read isolation tests |
| Custom plans | Authenticated create/read/update visibility and isolation tests |
| Plan assignment | Scope, ownership, foreign-user, and preservation tests |
| Consumption, usage, and history | Pending later metering tasks |

Every error uses the envelope `{ "error": { "code": "...", "message": "..." }, "correlationId": "..." }`. Fastify generates the correlation ID for each HTTP request, includes it in the `X-Request-Id` response header, and attaches the same request ID to its logs. This server-generated correlation ID is separate from the client-supplied consumption `requestId` used for safe retries.

Application logging redacts the `X-API-Key` and `Authorization` request headers as `[REDACTED]`. Smoke tests cover database-aware health responses, JSON `404` responses, malformed JSON, safe dependency-failure responses, and credential redaction.

The server handles `SIGINT` and `SIGTERM` as graceful-shutdown requests. It stops accepting HTTP traffic, waits for Fastify to close its listener, and then closes the PostgreSQL connection pool. This is the path used by `Ctrl+C` and `docker compose stop`.

## Core concepts

The service meters one resource: **document-processing units**.

| Concept | Meaning |
| --- | --- |
| Account | An application or company that calls the service. Its plan limits usage shared by all of its users. |
| User | A user registered under an account. The user's plan defines individual limits. |
| Plan | A named set of configurable quota rules assignable to an account or user. |
| Consumption decision | The accepted or rejected result of a request to consume a positive whole number of units for a user. |

## Core accounting invariant

An accepted action adds the same number of units to the user total and the account total for the current UTC calendar month. The account total is the sum of accepted usage across its users for that month. These totals are two views of one action, not two separate charges.

A rejected action adds zero units at both levels.

For example, if an account has 30 units remaining and a user has 10 remaining, accepting a 4-unit request leaves the account with 26 and the user with 6. If the account has 5 remaining and a user has 20, a 10-unit request is rejected and both totals remain unchanged.

## Required behavior and implementation choices

The project requires TypeScript, PostgreSQL, one metered resource, account API keys, account and user plans, monthly allowances, maximum units per request, persistent history, safe retries, concurrent-request correctness, and a full-stack Docker Compose command.

Route names, framework details, database schema, HTTP status choices, pagination format, rule-evaluation order, and other unspecified behavior are implementation decisions. Each material decision and its reasoning will be documented here as it is made.

## Product decisions

These decisions define the API contract that later implementation and tests will follow.

### Provisioning and authentication

- Accounts and their initial API keys are created through an operator CLI. This keeps account provisioning outside the customer-facing HTTP API.
- Authenticated HTTP endpoints require an `X-API-Key` header. The service derives the account from that key; callers cannot select another account by including an `accountId` in a request body or query string.
- A missing or invalid API key returns `401 Unauthorized`. A resource that is missing or belongs to another account returns `404 Not Found`, which avoids revealing another account's data.

### Months, usage, and plan changes

- Monthly allowances use UTC calendar months, identified as `YYYY-MM`. A new UTC month starts with zero usage while earlier months remain available for queries.
- Consume decisions are immutable historical snapshots. They retain the result, reason, applied rules, and balances recorded when the request was first decided.
- Usage and plan-inspection endpoints show the plans currently assigned. Remaining allowance is calculated as `max(0, current monthly limit - consumed)`.
- Updating or switching a plan affects later requests but never resets usage or rewrites earlier decisions. For example, after consuming 12 units, lowering the monthly limit to 10 leaves `consumed = 12` and reports `remaining = 0`.

### Request identifiers and safe retries

- Every consume request supplies a caller-generated `requestId`. It is scoped to the authenticated account and must contain 1–128 characters from letters, digits, `.`, `_`, `:`, and `-` (the pattern `^[A-Za-z0-9._:-]{1,128}$`). Two accounts may therefore use the same identifier independently.
- Repeating the same account, `requestId`, `userId`, and `units` returns the original recorded response without consuming units again. This applies to accepted and quota-rejected decisions.
- Reusing an account's `requestId` with a different `userId` or `units` returns `409 Conflict` and creates no new decision or usage.
- A replay stays historical even if a plan changes. If a request was rejected and its allowance is later increased, retrying the same ID and payload returns the original rejection; the caller needs a new request ID for a new decision.

### Numeric and request validation

- Consumption `units` must be a JSON number that is a positive safe integer. Plan limits must be JSON numbers that are non-negative safe integers; zero is a valid deny-all limit.
- The largest accepted value for `units` or a plan limit is `2,147,483,647`. This bound is represented exactly by JavaScript numbers and PostgreSQL integers, and monthly quota enforcement keeps accepted totals within it.
- Values such as `0`, `-1`, `1.5`, the string `"4"`, a missing value, or an integer above the bound are rejected with `400 Bad Request` before quota accounting.
- Mutation bodies reject unknown fields rather than ignoring misspellings, ownership overrides, or duplicate concepts. JSON values are validated without string-to-number coercion.
- Request IDs contain 1–128 characters from letters, digits, `.`, `_`, `:`, and `-`. Custom-plan names are trimmed, must contain 1–100 characters, and may not be blank.
- Only a request with valid authentication, valid input, and a user owned by the authenticated account becomes a consumption decision. A valid quota rejection is recorded because it is a real decision; authentication, validation, ownership, and request-ID conflict failures are not.

### Consumption contract

`POST /consume` accepts exactly `userId`, `units`, and `requestId`. Account
identity always comes from `X-API-Key`. Both accepted and quota-rejected
decisions use one response shape containing the normalized request, processing
time and UTC month, decision-time account/user balances, applied plan IDs and
revisions, and `blockedBy`. An acceptance has `blockedBy: null`; a rejection
identifies its `account` or `user` scope, `monthly_limit` or
`max_units_per_request` rule, and blocking limit.

A completed quota rejection is a `200` business decision and will be recorded.
Invalid input (`400`), invalid authentication (`401`), an unknown or foreign
user (`404`), and conflicting request-ID reuse (`409`) are API errors and do
not alter usage or create a decision. Task 16 fixes this boundary; the pure
rule evaluator and database-backed transaction are implemented in the
following metering tasks. Full examples are in [`docs/api.md`](docs/api.md).

### Endpoint checklist

The API will provide endpoints for:

- inspecting the authenticated account;
- creating and inspecting users within that account;
- listing, creating, inspecting, and updating plans, plus assigning account and user plans;
- consuming units with `POST /consume`;
- querying current and previous account and user usage; and
- reading consumption-decision history with pagination.

Exact paths for the remaining resources and detailed request and response examples will be documented as those routes are implemented.

### HTTP and decision errors

| Status | Meaning |
| --- | --- |
| `200 OK` | A valid consumption decision, whether accepted or rejected by a quota rule. The body includes `accepted` and an explicit reason. |
| `400 Bad Request` | Malformed JSON, an invalid request identifier, an invalid numeric value, or another invalid input. |
| `401 Unauthorized` | The `X-API-Key` header is missing or invalid. |
| `403 Forbidden` | A caller attempts to modify a predefined plan. |
| `404 Not Found` | A requested resource does not exist or belongs to another account. |
| `409 Conflict` | An account-scoped request ID is reused with a different user or quantity. |
| `422 Unprocessable Content` | A valid plan cannot be used for the requested assignment because its account/user scope is incompatible. |

## Delivery checklist

The final submission must include:

- A GitHub repository containing the service, predefined plans, and straightforward setup instructions.
- A complete Docker Compose stack containing PostgreSQL, the service, startup initialization, and a runnable example client.
- A README covering the API, model, API keys, rules, plan changes, retry behavior, assumptions, design decisions, and known limitations.
- Automated tests for the important behaviors, including API-key validation, account isolation, safe retries, and concurrent requests.
- Reproducible performance tests, scripts, configuration, commands, dependencies, results, and a short explanation of what was learned.

## Scope

### In scope

- One TypeScript backend service
- One PostgreSQL database
- One resource measured in document-processing units
- Account-level and user-level plans
- Account API-key authentication and account isolation
- A small example client
- Startup initialization, persistent request history, safe retries, concurrency tests, and performance evidence

### Out of scope

- Billing and payments
- Refunds
- End-user login
- Multiple resource types
- Role-based access control
- Distributed infrastructure

## Timeline

The estimate is 42 working hours. The dated project window is October 12-20, 2026; the brief also describes the timeline as one week.

## Documentation to complete during implementation

- Local setup and Docker Compose
- API authentication, endpoints, and examples
- Consumption, retry, and concurrency behavior
- Plan changes and UTC month handling
- Product assumptions and design decisions
- Automated and performance testing
- Known limitations
