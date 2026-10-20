# Thought Process

This project is a usage metering and quota service.

## Database

Each account represents a company and under each account there is many users there is a user limit and an account limit.

We use UUIDs for accounts and users, and integer IDs for plans. UUIDs make IDs harder to guess, but account security comes from API-key authentication and ownership checks, not the ID format.

2,147,483,647 is the maximum signed PostgreSQL integer, so we use it as the maximum monthly limit, per-request limit and unit count. Limits can be zero; consumption units must be positive whole numbers.

- `accounts`: application-generated UUID `id` (primary key), name, API-key digest, account-plan ID and creation time. The server stores the digest; the client keeps the raw key.
- `plans`: integer plan ID, nullable `owner_account_id` foreign key, account/user scope, limits, revision, and creation/update times. A null owner means a predefined plan.

```sql
ALTER TABLE accounts
  ADD CONSTRAINT accounts_account_plan_fk
  FOREIGN KEY (account_plan_id)
  REFERENCES plans(id)
  ON DELETE RESTRICT; -- Makes the account plan a foreign key.
```

- `users`: UUID ID, owning account ID, user-plan ID, creation time, and a unique `(account_id, id)` pair.

Account monthly usage uses `(account_id, usage_month)` as its primary key. User monthly usage uses `(user_id, usage_month)` and also stores the owning account ID. A composite foreign key prevents a user bucket from referring to another account.

### Migrations

Migrations let us change the database without deleting everything and recreating it.

`migrate.ts` reads the SQL migration files, runs the ones not yet recorded, and records each successful migration in the same transaction. It does not generate migration files.

The `schema_migrations` table acts as the database's migration memory, so rerunning initialization skips migrations already applied.

## Behaviour

Accounts are created through the operator CLI:

```bash
npm run account:create -- --name "Example Company"
```

Authentication identifies which account is calling the API. Authorization separately decides whether that account may access a specific user, plan, or other resource.

GET /health is public and does not require an API key.

GET /account is protected:
```http
GET /account
X-API-Key: <issued-account-key>
```

The account identity comes only from the API key. An accountId supplied in the URL, query string, or request body cannot override the authenticated account.

we identify each action using account_id + requestId.
same ID, user and units → return the original accepted/rejected response without charging again.
same ID with different user or units → 409 conflict.
retries keep the original result even after plan changes or a new month.
a new decision needs a new requestId.

Changing a plan does not erase usage. We calculate remaining allowance as `Math.max(0, monthlyLimit - consumed)`.

## API-key authentication

The raw API key is shown once. The DB stores only its HMAC-SHA-256 digest.

The pepper is the HMAC key and the raw API key is the message; this is not simple concatenation:

```text
HMAC-SHA-256(key = API_KEY_PEPPER, message = apiKey) -> digest
```

### Authentication flow

```text
X-API-Key
    ↓
Validate its format
    ↓
Calculate its digest
    ↓
Find the matching account
    ↓
Store it in request.authenticatedAccount
```

GET /health is public.

GET /account requires a valid API key and returns the account and its plan.

Missing, invalid, and unknown keys all return the same 401 response. Tenant API responses and HTTP logs do not expose the raw key or digest. The operator provisioning CLI reveals the raw key once when creating the account.

Authentication survives restarts because the digest is stored in PostgreSQL.

## Tenant isolation

Each account is a tenant, meaning its users, custom plans, usage and history must stay separate from every other account.

Every user query checks both the user id and the account authenticated by the API key:

```sql
WHERE users.account_id = $1 AND users.id = $2
```

Account A trying to access account B's user gets the same 404 USER_NOT_FOUND response as a user that doesn't exist. This stops us from leaking whether another account owns that user.

POST /users also gets ownership from the API key. Sending accountId in the body cannot create a user for another account.

Predefined plans are shared, but custom plans can only be accessed by their owner:

```sql
owner_account_id IS NULL OR owner_account_id = authenticatedAccountId
```

## TypeScript environment

The project uses Node.js 22.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run TypeScript directly and restart when source files change |
| `npm run typecheck` | Check TypeScript without generating output files |
| `npm run build` | Compile TypeScript into JavaScript under `dist/` |
| `npm start` | Run the compiled JavaScript |
| `npm test` | Run the automated tests; database suites need a configured disposable test database |

TypeScript checks types before runtime, so we also use Zod to validate incoming data while the API is running.

## Docker and Docker Compose

Docker Compose starts related containers together.

Compose puts the API, database and demo on a shared network so they can reach each other by service name.

We use a named volume so database data survives container removal and recreation, as long as the volume itself is retained.

The address depends on where the caller runs:

| Caller | Address |
| --- | --- |
| Host terminal to API | `http://localhost:3000` with the default API port |
| Host terminal to PostgreSQL | `localhost:55432` with the supplied example configuration |
| API container to PostgreSQL | `db:5432` |
| Demo container to API | `http://api:3000` |

`localhost` always refers to the caller's own machine or container. Inside a container, it refers to that container, not another Compose service.

The API startup connection check tries up to 10 times, with a one-second delay between failed attempts. It does not retry indefinitely.

The Dockerfile builds the application and defines its runtime.

### Initial HTTP setup

- `app.ts` builds the API and registers routes, authentication and error handling.
- `server.ts` loads configuration, connects the database operations and starts the server.

The JSON request-body size limit is 1 MiB (1,048,576 bytes).

Accounts and users use UUIDs. Plans use integer IDs. UUIDs do not provide account security by themselves; authentication and ownership checks do.

We use documented HTTP status codes and consistent JSON error messages.

## Plan seeding

Seeds provide the required starting plans. Seeding is idempotent: rerunning it does not duplicate the predefined plans or overwrite existing ones.

### Startup order

```text
PostgreSQL becomes healthy
          ↓
init service runs migrations
          ↓
init service inserts predefined plans
          ↓
API starts
```

### Custom plans

The predefined plans are Starter and Pro for accounts, and Basic and Premium for users.

An authenticated account can create its own custom plans through a POST request using its API key.

```http
POST /plans
X-API-Key: <issued-account-key>
Content-Type: application/json

{
  "name": "Small User Plan",
  "scope": "user",
  "monthlyLimit": 50,
  "requestLimit": 5
}
```

Custom plans support both `account` and `user` scopes. This example uses `user` because it defines a user plan. Unlike predefined plans, every custom plan has an owner, taken from the authenticated account's API key.

We can update an owned custom plan using `PATCH /plans/:id` and supplying the changed settings in the body.

We assign plans through `PATCH /account/plan` or `PATCH /users/:id/plan`, with `planId` in the body. The account identity comes only from the API key; the user route also takes a user ID in its path. Ownership and scope checks prevent cross-account or incompatible assignments.

#### Account-plan assignment in SQL

```sql
UPDATE accounts
SET account_plan_id = $2
WHERE id = $1;
```

we also have a scope attribute so we can ensure user plans cant be assigned to accounts and vice versa

plan changes affect new decisions without resetting usage or rewriting old decisions.
if consumed is 8, switching to limit 20 leaves 12 remaining.
downgrading to limit 5 keeps consumed at 8 and clamps remaining to 0.

shared plan edits update everyone's rules, but each user's usage stays separate.
plan changes and consumption use the same account lock.
whichever gets the lock first completes first; the next operation reads the committed state

```text
GET /account/rules → current account plan + usage
GET /users/:id/rules → current account AND user plans + usage
```

Both need X-API-Key. No body or month parameter;
always the current UTC month.

Shows plan id, name, scope, monthlyLimit,
maxUnitsPerRequest, revision, consumed and remaining.

Reads assignments, plans and counters together in one SQL
statement so the response represents one consistent moment

Two users can share one plan definition without sharing usage.
Updating that plan changes both users' limits immediately,
but their consumed amounts stay separate.

Switching plans takes effect immediately without resetting usage

## Error handling and validation
TypeScript only checks types while developing, so we use Zod to validate data when the API is actually running.

Examples of invalid input include:

- missing required values
- invalid UUIDs
- negative or decimal limits
- names that are too long
- unknown properties in the request body

Strict validation means a request with unexpected fields like accountId is rejected instead of silently ignored.

Errors use a consistent format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request body is invalid."
  },
  "correlationId": "req-123"
}
```

The HTTP status and error code tell the client what happened. For example:

400 INVALID_REQUEST = invalid request data

401 UNAUTHORIZED = missing or invalid API key

404 USER_NOT_FOUND = user is missing or belongs to another account

404 PLAN_NOT_FOUND = plan is missing or belongs to another account

422 PLAN_SCOPE_MISMATCH = trying to use an account plan for a user or the opposite

Request IDs have a maximum length, and quantities have numeric bounds. These checks reject unsupported values and help prevent accounting overflow.

## Consumption

each consumption request will look something like this:
```http
POST /consume
X-API-Key: <issued-account-key>
Content-Type: application/json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "document-123"
}
```
account id comes from the api key but the userid is sent in the request body

we also ensured using z that the request body only has these 3 parameters

example response body:
```json
{
  "requestId": "document-123",
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "accepted": true,
  "processedAt": "2026-10-17T12:30:00.000Z",
  "month": "2026-10",
  "account": {
    "consumed": 4,
    "remaining": 9996,
    "plan": {
      "id": 1,
      "revision": 1
    }
  },
  "user": {
    "consumed": 4,
    "remaining": 996,
    "plan": {
      "id": 3,
      "revision": 1
    }
  },
  "blockedBy": null
}
```

For a rejection, `blockedBy` identifies the blocking rule, its account/user scope and its limit. The blocker can be a per-request cap or a monthly allowance.

rejected requests still give a response code of 200 because there was no error it was just a business issue
while other errors will give out normal error codes like 400, 401 ,404 etc

`evaluate-rules.ts` checks these in order:

1. account per-request limit
2. user per-request limit
3. account monthly allowance
4. user monthly allowance

all must pass; blockedBy shows the first failure.
exact limits are allowed, zero limits block positive requests.

accepted adds units to both proposed totals; rejected changes neither.
we check remaining before adding to avoid overflow.

it's a pure function: calculates the result without changing inputs or the DB.

we store usage separately for each account/user and month. if a user used 8 units in October, November starts at 0 while October's 8 stays saved.
getUtcMonth turns a timestamp into a month label like 2026-10-01, meaning the whole of October, using UTC. missing records read as 0,
and creating an existing record again doesn't reset it. usage belongs to the account/user, so sharing or changing a plan doesn't merge or erase their usage.

### UTC month rollover
new months get separate usage rows starting at 0; old rows stay unchanged.

we capture processing time after getting the account lock.
a request waiting across midnight uses the new month.
we choose the month once for both counters and the decision, even if midnight passes between writes.

retrying an old ID returns its original month and result without charging the new month.
year boundaries and timezone offsets are handled using UTC

### Usage queries

```text
GET /usage → account usage
GET /users/:id/usage → account + that user's usage
```

Both need the API key, no request body.
Optional ?month=2026-10; otherwise current UTC month.

Current month returns consumed, monthlyLimit and remaining.
Other months return consumed only since plans could've changed.

### Transactions
we use one DB connection and one transaction for the whole consumption request.
a transaction groups changes together so they either all get saved or all get undone:

```text
BEGIN → start the transaction
COMMIT → save all its changes together
ROLLBACK → undo its changes if something fails
```

example: if account usage increases but the user update fails, rollback undoes the account increase too.
we lock the account first using FOR UPDATE, so competing mutations for that account wait until we commit or roll back.
after getting the lock, we read fresh plans/usage and capture the processing time. this ensures a request waiting across midnight uses the correct month.

```text
accepted → increase account usage + user usage + save the decision
rejected → leave both totals unchanged + save the decision
```
We commit the transaction and release the connection back to the pool before the HTTP route sends the result.

### Another consumption example
```http
POST /consume
X-API-Key: <issued-account-key>
Content-Type: application/json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "document-1"
}
```

if a request was rejected and then we changed the plan to increase credits we must submit a new request with a new request id

we save a snapshot containing the response and the actual limits checked.
the balances in it are values at decision time, not live balances.

failure before commit → rollback both counters and the decision.
the same ID can then be retried successfully because nothing was committed.

commit succeeds but response is lost → retry the same ID to recover the saved result without another charge.

we verified that keys, plans, assignments, usage and decisions survive restarts with the database volume retained.
the API reconnects after PostgreSQL restarts, and new requests still work.
technical failures return a safe 500, not a quota rejection or false acceptance

GET /history lists accepted/rejected decisions with their original
balances and rules. Needs API key, no body.

Optional: userId, month, limit (default 20, max 100).

Returns decisions + nextCursor. Send that cursor for the next
page with the same filters. null = finished.

Ordered by sequence number. New decisions won't shift your pages.
Plan changes don't rewrite history; retries don't add duplicates.
Each account can only see its own history.

Plan edits and consumption use the same account lock.
Whoever gets it first goes first; saved decisions keep those rules.

New requests see updated plans; retries keep the original result

## Demo and verification

Terminal client calls our API using fetch + API key.
For the npm demo, configuration comes from `demo/.demo.env`, which is ignored by Git. The Docker Compose demo instead keeps its freshly issued key in memory.

demo:setup creates fresh demo data; demo:run uses it.
Simulated work only happens after acceptance.

PATCH changes limits without changing client code.
New action = new requestId; retry = original decision.

Snapshot = balances then; live usage = balances now.

### Full stack with Docker Compose

docker compose up --build runs the whole project.

DB healthy → init finishes → API healthy → demo.
The configured `depends_on` conditions wait for database/API health checks and successful initialization. Service ordering alone would not establish readiness.

init does migrations + seeding.
demo creates a fresh account; key stays in memory.

Demo exits 0 when done; API + DB keep running.
Named volume preserves data after down/up.

Containers use db:5432 and http://api:3000.

test:compose checks startup + data surviving restart

#### Startup flow
```text
PostgreSQL is ready
        ↓
init finishes migrations and seeding
        ↓
API starts and passes its health check
        ↓
demo creates its account and runs the example
```

`npm run verify` runs the full regression gate.

```text
typecheck → build → tests + restarts → Compose check.
```
Stops on the first failure

## Load testing

`npm run perf` sends a fixed number of HTTP requests.

requests = total actions; concurrency = max happening at once.
Fresh fixtures + unique request IDs; no retries.

Measures requests/sec and latency p50/p95/p99.
Quota rejections and technical failures are counted separately.

Afterward: account usage = user totals = accepted ledger units.
Mismatch or unexpected failure = failed run

### Performance comparison

Compared one busy account vs ten accounts, same 20 users.
2000 requests at concurrency 1, 10 and 50; repeated 3 times.

Same-account requests take turns because of the account lock.
Separate accounts can work in parallel.

More workers can mean more waiting, not more speed.

Report explains the benchmarks, bottleneck and limitations.
DB samples showed heavy account-lock waiting for one busy account
