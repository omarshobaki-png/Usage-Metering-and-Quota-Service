# API reference

Start the stack and obtain an operator-issued account key using the
[README walkthrough](../README.md#try-the-api). Requests use JSON and the
`X-API-Key` header. Example UUIDs, plan IDs, timestamps, and cursors below are
illustrative; use values returned by your own fixture.

- [Routes](#routes)
- [Validation](#validation)
- [Accounts, users, and plans](#accounts-users-and-plans)
- [Consumption contract](#consumption-contract)
- [Monthly usage](#monthly-usage)
- [Current applied rules](#current-applied-rules)
- [Decision history](#decision-history)
- [Errors](#errors)

## Routes

All routes except `GET /health` require an account key. Account creation is an
operator CLI action. There is no public account-provisioning endpoint, user-list
route, `/requests` route, or `/ready` endpoint.

| Method / path | Input | Successful response |
| --- | --- | --- |
| GET /health | None | 200 health, or 503 if PostgreSQL is unavailable |
| GET /account | None | `{account}` with its current assigned plan |
| POST /users | `{}` or `{planId}` | 201 `{user}` |
| GET /users/:id | Owned user UUID | `{user}` and its current plan |
| GET /plans | Optional `scope=account` or `scope=user` | `{plans}`: predefined + owned custom plans |
| POST /plans | `{name,scope,monthlyLimit,requestLimit}` | 201 `{plan}` |
| GET /plans/:id | Available plan integer ID | `{plan}` |
| PATCH /plans/:id | At least one mutable field | Updated `{plan}` |
| PATCH /account/plan | `{planId}` | Updated `{account}` |
| PATCH /users/:id/plan | `{planId}` | Updated `{user}` |
| POST /consume | `{userId,units,requestId}` | 200 accepted or quota-rejected decision |
| GET /usage | Optional `month` | Account usage for that month |
| GET /users/:id/usage | Owned UUID; optional `month` | Account and individual user usage |
| GET /account/rules | No query parameters | Current account plan and balance |
| GET /users/:id/rules | Owned UUID; no query parameters | Current account/user plans and balances |
| GET /history | Optional `limit,userId,month,cursor` | `{decisions,nextCursor}` |

`GET /health` returns `{"status":"ok","database":"reachable"}` when healthy.
It probes PostgreSQL and returns an unhealthy 503 response on connection failure.

## Validation

Mutation bodies are strict JSON objects: unknown fields, ownership overrides,
numeric strings, fractions, and out-of-range quantities return 400.
User creation accepts an omitted body as `{}` and defaults to Basic.

| Field | Accepted value |
| --- | --- |
| userId | UUID belonging to the authenticated account |
| planId | Integer 1–2,147,483,647; available plan of the required scope |
| units | Integer 1–2,147,483,647 |
| monthlyLimit / requestLimit | Integer 0–2,147,483,647; zero denies positive consumption |
| name | Trimmed nonempty plan name, at most 100 characters |
| scope | Exactly `account` or `user`; immutable after creation |
| requestId | Case-sensitive 1–128 characters matching `^[A-Za-z0-9._:-]{1,128}$` |
| month | Exactly `YYYY-MM`, years 0001–9999 and months 01–12 |

Plan-list, usage, rules, and history queries reject unsupported parameters;
duplicate query parameters also fail their schemas. Malformed user/plan path IDs
receive the same 404 as missing resources. The JSON body limit is 1 MiB.

The authenticated key determines the account. Foreign users/custom plans return
404 without disclosing tenant data. Missing, malformed, and well-formed unknown
keys receive a generic `401 UNAUTHORIZED`. Supply the issued raw key, not the
server's private `API_KEY_PEPPER`.

## Accounts, users, and plans

`GET /account` returns account ID, name, and current plan.
`POST /users` returns the new user's ID, account ID, creation time, and plan;
`GET /users/:id` returns the same shape with the current assigned definition.

Catalog plan objects contain these fields:

```json
{
  "plan": {
    "id": 5,
    "name": "Account Burst",
    "scope": "account",
    "monthlyLimit": 30,
    "requestLimit": 100,
    "revision": 1,
    "owner": "account"
  }
}
```

`owner` is `predefined` for global defaults and `account` for owned definitions.
The catalog's `requestLimit` and assigned-plan/rules responses'
`maxUnitsPerRequest` represent the same per-request cap.

Create and update a custom plan using the returned ID:

```bash
curl --fail-with-body -X POST http://localhost:3000/plans \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Account Burst","scope":"account","monthlyLimit":30,"requestLimit":100}'

curl --fail-with-body -X PATCH "http://localhost:3000/plans/$ACCOUNT_PLAN_ID" \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"monthlyLimit":50}'
```

Updates accept only `name`, `monthlyLimit`, and `requestLimit`; at least one is
required. Each successful update increments revision once. Scope and ownership
cannot change. Predefined plans are readable and return 403 on modification.

Assignments accept `{"planId":5}` on `PATCH /account/plan` or
`PATCH /users/:id/plan`. The plan must be global or owned by the calling account
and have the subject's scope. Wrong-scope visible plans return 422; unavailable
plans or foreign users return 404. A switch changes the assignment without
incrementing the selected plan's revision.

Usage remains attached to the account/user and UTC month. A switch or definition
edit never resets it or alters old decisions. Shared user plans share definitions,
while each user keeps its own allowance consumption. Downgrades below usage leave
that usage intact and clamp current remaining units to zero.

Consumption, plan mutations, and assignment switches take the same account lock.
New requests started after a successful mutation response see its committed
configuration; overlapping operations follow lock acquisition order. See the
[transaction design](../README.md#atomicity-concurrency-and-utc-months).

## Consumption contract

A request is an all-or-nothing positive quantity for one owned user:

```json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "doc-2026:01"
}
```

For example, using a returned user UUID:

```bash
curl --fail-with-body -X POST http://localhost:3000/consume \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER_ID\",\"units\":4,\"requestId\":\"doc-2026:01\"}"
```

Under Starter/Basic at zero usage, the accepted HTTP 200 response has this shape:

```json
{
  "requestId": "doc-2026:01",
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "accepted": true,
  "processedAt": "2026-10-16T12:30:00.000Z",
  "month": "2026-10",
  "account": {
    "consumed": 4,
    "remaining": 9996,
    "plan": { "id": 1, "revision": 1 }
  },
  "user": {
    "consumed": 4,
    "remaining": 996,
    "plan": { "id": 3, "revision": 1 }
  },
  "blockedBy": null
}
```

A new 25-unit request against Basic's 20/request cap also returns HTTP 200.
It has `accepted: false`, unchanged balances, and this `blockedBy` value:

```json
{ "scope": "user", "rule": "max_units_per_request", "limit": 20 }
```

The possible rules are `max_units_per_request` and `monthly_limit`, each with
`account` or `user` scope. First-blocker precedence is account per-request,
user per-request, account monthly, then user monthly.

Accepted balances include the action; rejected balances preserve both totals.
All response values are immutable snapshots at `processedAt`, including
plan IDs/revisions, remaining units, and the blocker.

### Safe retries

The key is `(account_id, request_id)` across all users and months:

- Identical normalized user/units returns the original accepted or rejected body.
- Changing either payload field returns `409 REQUEST_ID_CONFLICT`.
- Another account may use the same identifier independently.
- Plan changes, month rollover, and restarts do not change a saved response.
- A rejected ID remains rejected after an upgrade; use a new ID for a fresh action.

A replay creates no usage increment, new-month bucket, or history row. IDs have
no expiration. Deleting the database destroys history and retry protection.
Authentication, validation, user ownership, and payload conflict checks still
apply when replaying. Only valid processed quota decisions enter history.

If a transaction fails before commit, both counters and its decision roll back.
Retrying its ID can then produce one committed decision. If the response is lost
after commit, retry the same ID/payload to recover that original outcome.
The service does not deduplicate a separate application's business side effects.

## Monthly usage

`GET /usage` returns the account balance; `GET /users/:id/usage` adds the
individual user's balance. Optional `month=YYYY-MM` defaults to the current UTC
month, using the database clock. Account usage includes all of its users.

A current-month response may look like:

```json
{
  "month": "2026-11",
  "isCurrentMonth": true,
  "account": {
    "id": "00000000-0000-4000-8000-000000000010",
    "consumed": 3, "monthlyLimit": 10000, "remaining": 9997
  },
  "user": {
    "id": "00000000-0000-4000-8000-000000000020",
    "consumed": 3, "monthlyLimit": 1000, "remaining": 997
  }
}
```

The account route omits `user`. Missing buckets read as zero without writes.
Current remaining is `max(0, current monthly limit - consumed)`.
Explicitly selecting the current month has the same fields as omitting it.

Noncurrent months, including future ones, return `isCurrentMonth: false` and
only each subject's `id` and `consumed`. They omit `monthlyLimit` and `remaining`;
individual saved decisions preserve the rules that applied at their own times.
Reads use one SQL statement snapshot for related counters, plans, and ownership.

Consumption captures processing time once after acquiring the account lock.
Both counters and the decision use that UTC month, even if the request queued
before midnight. Previous months are retained as separate buckets.

## Current applied rules

`GET /account/rules` returns `month` and `account`; `GET /users/:id/rules`
also returns `user`. Each subject has `id`, `plan`, `consumed`, and `remaining`.
The plan includes ID, name, scope, monthly limit, `maxUnitsPerRequest`, and revision.

These routes always describe the current UTC month and accept no query
parameters. Use usage routes for other months. Reads share one statement snapshot
and do not lock the account for writing.

For a user with usage 4, raising its monthly limit from 10 to 20 changes current
remaining from 6 to 16 and exposes the new revision. Replaying its earlier
decision still returns the old remaining value and revision.

## Decision history

`GET /history` returns `{"decisions":[...],"nextCursor":...}`.
Entries include accepted and rejected outcomes, newest sequence first.

| Query | Meaning |
| --- | --- |
| limit | Default 20; decimal integer 1–100 without leading zeros |
| userId | Optional owned user UUID |
| month | Optional UTC accounting month |
| cursor | Returned base64url continuation value, at most 1024 characters |

Every entry contains the full consumption response plus `sequence` and
`evaluatedLimits`. These additional fields have this shape:

```json
{
  "sequence": "6",
  "evaluatedLimits": {
    "account": { "monthlyLimit": 10000, "maxUnitsPerRequest": 100 },
    "user": { "monthlyLimit": 1000, "maxUnitsPerRequest": 20 }
  }
}
```

Sequences are decimal strings so BIGINT values remain exact. Stored snapshots
supply the decision fields and evaluated limits; current plans are not substituted.

Continue with `nextCursor` while retaining the same user/month filters. Page size
may change. A last or empty page returns `nextCursor: null`. Invalid cursors or
filter/account mismatches return 400; a missing/foreign user filter returns 404.

The cursor retains the first page's upper sequence and moves below the last
returned sequence. Later inserts appear on fresh queries, outside that session.
Equal timestamps and rollback sequence gaps do not affect ordering. Migration
backfills give older rows a deterministic timestamp/account/request-ID order.

Cursors identify a position, not account authority. Every page still uses the
authenticated account predicate. They remain usable after restart with retained data.

## Errors

Error responses include a server-generated correlation ID:

```json
{
  "error": { "code": "INVALID_REQUEST", "message": "Request body is invalid." },
  "correlationId": "req-1"
}
```

The response `X-Request-Id` header identifies the HTTP request and differs from
the client's consumption `requestId`.

| Status | Code | Meaning |
| ---: | --- | --- |
| 400 | INVALID_JSON | Malformed JSON |
| 400 | INVALID_REQUEST | Invalid body, query, filter, or cursor |
| 401 | UNAUTHORIZED | Missing or invalid API key |
| 403 | PREDEFINED_PLAN_READ_ONLY | Editing a predefined plan |
| 404 | USER_NOT_FOUND / PLAN_NOT_FOUND / NOT_FOUND | Missing/foreign resource or unknown route |
| 409 | REQUEST_ID_CONFLICT | Same account/request ID with a changed payload |
| 413 | BODY_TOO_LARGE | JSON body exceeds 1 MiB |
| 415 | BAD_REQUEST | Unsupported content type |
| 422 | PLAN_SCOPE_MISMATCH | Visible plan has the wrong assignment scope |
| 500 | INTERNAL_ERROR | Unexpected failure; retry an uncertain consume with its original ID |
| 503 | DATABASE_UNAVAILABLE | PostgreSQL health probe failed |

Error responses exclude SQL, stack traces, digests, connection URLs, and raw keys.
Application logs redact API-key and Authorization headers. Missing/invalid-key,
validation, ownership, and conflict errors change no usage or decision history.
