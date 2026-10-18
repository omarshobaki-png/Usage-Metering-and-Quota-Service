# API validation and errors

All tenant endpoints authenticate with `X-API-Key`. The authenticated key is the
only source of account ownership; request bodies never accept `accountId`.

Send the account's raw `umq_...` key, not `API_KEY_PEPPER`. The pepper is a
server-side secret used to compute the stored digest. Local account provisioning
and the normal Docker API/init share `API_KEY_PEPPER` from the environment/`.env`;
there is no separate hardcoded normal-Docker pepper. Missing/empty Compose pepper
settings stop startup rather than silently selecting another secret.

If a correctly formatted key gets `401`, run `npm run config:check` to detect
configuration drift or an API container still running with an older pepper.
After changing container settings, use `docker compose up -d --no-deps --wait api`
to apply them; a plain container restart does not replace its environment. Keep
the original pepper stable so previously issued keys remain valid.

## Mutation-body policy

Mutation bodies are strict JSON objects. Unknown fields are rejected with
`400 INVALID_REQUEST`, which makes misspellings and attempted ownership
overrides visible instead of silently ignoring them. Numeric strings are not
coerced into numbers.

| Body | Fields |
| --- | --- |
| Create user | Optional `planId`: positive integer, at most `2,147,483,647` |
| Create custom plan | `name`, `scope`, `monthlyLimit`, `requestLimit` |
| Update custom plan | At least one of `name`, `monthlyLimit`, `requestLimit` |
| Assign plan | `planId` |
| Consume units | `userId`, `units`, `requestId` |

Plan scope is exactly `account` or `user`. Plan names are trimmed and contain
1–100 characters. Monthly and request limits are whole numbers from 0 through
`2,147,483,647`; zero is a valid deny-all limit.

Consumption `units` is a JSON number from 1 through `2,147,483,647`. `userId`
is a UUID. `requestId` contains 1–128 characters from letters, digits, `.`,
`_`, `:`, and `-`, matching `^[A-Za-z0-9._:-]{1,128}$`.

For example, this consumption body is valid:

```json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "doc-2026:01"
}
```

Changing `4` to `"4"`, adding `accountId`, omitting a field, or adding an
unknown field makes the body invalid.

## Monthly usage

| Method and path | Result |
| --- | --- |
| `GET /usage` | Authenticated account's monthly usage |
| `GET /users/:id/usage` | Same account total plus the owned user's monthly usage |

Both routes require `X-API-Key`. The only query parameter is optional
`month=YYYY-MM`, using exactly four year digits (0001–9999) and month 01–12.
The default is the current UTC calendar month, captured with PostgreSQL's
statement clock. HTTP callers cannot set the clock or account identity.
Unknown parameters, duplicate months, empty months, and malformed months
(for example `2026-13`, `2026-1`, or `2026-10-01`) return
`400 INVALID_REQUEST` with `Query parameters are invalid.` in the standard error
envelope. A missing/invalid API key returns `401` before query validation.

```bash
curl http://localhost:3000/usage -H "X-API-Key: ${API_KEY}"
curl "http://localhost:3000/users/00000000-0000-4000-8000-000000000020/usage?month=2026-11" \
  -H "X-API-Key: ${API_KEY}"
```

For example, during November 2026, after this user consumes 3 units and no other
user consumes anything that month, the user route returns `200 OK`:

```json
{
  "month": "2026-11",
  "isCurrentMonth": true,
  "account": {
    "id": "00000000-0000-4000-8000-000000000010",
    "consumed": 3,
    "monthlyLimit": 10000,
    "remaining": 9997
  },
  "user": {
    "id": "00000000-0000-4000-8000-000000000020",
    "consumed": 3,
    "monthlyLimit": 1000,
    "remaining": 997
  }
}
```

`GET /usage` returns the same `month`, `isCurrentMonth`, and `account` fields,
without the `user` field. Account consumption includes all its users; the user
balance includes only the requested user. A missing bucket returns `consumed: 0`
without inserting rows. A current-month response always uses current plan limits;
remaining is `max(0, monthlyLimit - consumed)`, including after a downgrade below
existing usage or an assignment switch. Usage is never reset by changing plans.

For a query for October made during November, an earlier 4-unit action appears
as consumed units only:

```json
{
  "month": "2026-10",
  "isCurrentMonth": false,
  "account": {
    "id": "00000000-0000-4000-8000-000000000010",
    "consumed": 4
  },
  "user": {
    "id": "00000000-0000-4000-8000-000000000020",
    "consumed": 4
  }
}
```

All noncurrent months, including future months, omit `monthlyLimit` and
`remaining`. No single historical allowance is inferred: plans can change
within a month, while each immutable decision retains its own rule snapshot.
Explicitly selecting the current month returns the same allowance fields as
omitting `month`.

Both totals, current plan limits, and user ownership are read in one SQL
statement snapshot, so a concurrent consumption commit cannot mix old account
usage with new user usage in one response. Reads do not modify buckets or
decision history. A user belonging to another account, an unknown UUID, and a
malformed user ID all return the same `404 USER_NOT_FOUND` without account or
user usage. The account always comes from the authenticated key.

## Decision history

```http
GET /history?limit=2
X-API-Key: your-issued-key
```

This authenticated GET request has no body. It returns accepted and rejected
decisions belonging to the calling account, newest sequence first.

| Query parameter | Meaning |
| --- | --- |
| `limit` | Optional page size, default 20, maximum 100; decimal integers 1–100 without leading zeros. |
| `userId` | Optional owned user's UUID. |
| `month` | Optional UTC accounting month, exactly `YYYY-MM`, years 0001–9999. |
| `cursor` | Optional continuation value copied from the previous response. |

Without user/month filters, history includes every user and month in the
account. Combined filters must both match. Missing/invalid keys return `401`.
Unknown parameters, duplicate parameters, malformed filters, invalid limits,
and invalid/mismatched cursors return `400 INVALID_REQUEST`. A valid UUID that
is missing or owned by another account returns the same `404 USER_NOT_FOUND`.

For example, after an earlier 4-unit acceptance, a rejected 25-unit request can
appear as the only record on a final page:

```json
{
  "decisions": [
    {
      "sequence": "6",
      "requestId": "doc-rejected",
      "userId": "00000000-0000-4000-8000-000000000020",
      "units": 25,
      "processedAt": "2026-10-17T12:30:00.000Z",
      "month": "2026-10",
      "accepted": false,
      "blockedBy": {
        "scope": "user",
        "rule": "max_units_per_request",
        "limit": 20
      },
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
      "evaluatedLimits": {
        "account": { "monthlyLimit": 10000, "maxUnitsPerRequest": 100 },
        "user": { "monthlyLimit": 1000, "maxUnitsPerRequest": 20 }
      }
    }
  ],
  "nextCursor": null
}
```

An accepted entry has `accepted: true` and `blockedBy: null`. All decision fields
and `evaluatedLimits` come from the stored snapshot, without joining live plan
definitions. Edits, assignment switches, and replay do not rewrite old entries.
The additional `sequence` is a decimal string to preserve PostgreSQL BIGINT
precision; it is an ordering key, not a unit balance. The normal consume response
has neither `sequence` nor `evaluatedLimits` and remains unchanged.

### Continuing a history query

If `nextCursor` is non-null, copy it to the next request and repeat the same
filters. For example:

```http
GET /history?limit=2&userId=00000000-0000-4000-8000-000000000020&month=2026-10
X-API-Key: your-issued-key
```

Continue with the returned cursor:

```http
GET /history?limit=2&userId=00000000-0000-4000-8000-000000000020&month=2026-10&cursor=RETURNED_CURSOR
X-API-Key: your-issued-key
```

`RETURNED_CURSOR` stands for the actual response value. The page size may change,
but changing or omitting a user/month filter used on the first page returns
`400 INVALID_REQUEST`. The last page and an empty query return `nextCursor: null`.

Ordering uses `decision_sequence DESC`. Equal or backward-moving timestamps do
not affect it. Each cursor retains the first page's highest sequence and advances
below the last returned sequence. Five original entries therefore appear once
on pages of 2, 2, and 1; a sixth decision inserted after page one is excluded
from that session and appears in a fresh history query. The account lock ensures
an unfinished lower-sequence decision cannot be overtaken by another consumption
commit for the same account. Rollback gaps are harmless.

Cursors are base64url pagination positions, not encrypted data or authorization
tokens. Their version, shape, size, positive BIGINT bounds, account, and filters
are checked. A cursor from another account is rejected. Even modified positions
cannot change the authenticated account predicate in SQL. Cursors are stateless
and continue working after API restarts while the same database is retained.

Existing decisions receive a stable backfilled order by `processed_at`, then
account UUID and request ID. That tie-break gives old data a deterministic order;
it cannot reconstruct an original insertion order that was never recorded.
New decisions receive an indexed sequence at insertion inside consumption's
account-locked transaction. Apply `npm run db:migrate` on existing databases
before using history; normal Compose initialization applies it automatically.

## Current applied rules

`GET /account` and `GET /users/:id` include the assigned plan's ID, name,
scope, monthly limit, `maxUnitsPerRequest`, and revision. To inspect those
definitions together with current usage and remaining allowance, use:

```http
GET /account/rules
X-API-Key: your-issued-key
```

```http
GET /users/00000000-0000-4000-8000-000000000020/rules
X-API-Key: your-issued-key
```

These requests have no body and accept no query parameters. In particular,
`?month=...` returns `400 INVALID_REQUEST`: applied-rule inspection always
means the current UTC month. Use the usage endpoints to query another month.
Missing/invalid keys return `401 UNAUTHORIZED`; foreign, missing, or malformed
user IDs return `404 USER_NOT_FOUND` without revealing rules or usage.

For example, assume a user has consumed 4 units under custom user plan 5,
initially 10/month and 5/request at revision 1. Update the shared definition:

```http
PATCH /plans/5
X-API-Key: your-issued-key
Content-Type: application/json

{"monthlyLimit":20,"requestLimit":10}
```

A subsequent user-rule inspection during October 2026 returns `200 OK`:

```json
{
  "month": "2026-10",
  "account": {
    "id": "00000000-0000-4000-8000-000000000010",
    "plan": {
      "id": 1,
      "name": "Starter",
      "scope": "account",
      "monthlyLimit": 10000,
      "maxUnitsPerRequest": 100,
      "revision": 1
    },
    "consumed": 4,
    "remaining": 9996
  },
  "user": {
    "id": "00000000-0000-4000-8000-000000000020",
    "plan": {
      "id": 5,
      "name": "Shared user plan",
      "scope": "user",
      "monthlyLimit": 20,
      "maxUnitsPerRequest": 10,
      "revision": 2
    },
    "consumed": 4,
    "remaining": 16
  }
}
```

The account-rule route returns the same `month` and `account`, without `user`.
A second user assigned to plan 5 sees that same revision 2 definition but keeps
its own consumed units (for example 0) and remaining allowance (20). Missing
usage buckets read as zero without inserting rows. Remaining is clamped at zero
after a downgrade below accumulated usage.

Assignments, shared plan definitions, ownership, and both usage counters come
from one SQL statement snapshot. Reads do not lock the account for writing.
Both scopes' rules constrain consumption: a generous user plan cannot bypass
the account's limits. These values describe the inspection snapshot; a later
consume request checks the then-current rules in its own transaction.

### Current inspection versus an older decision

Replaying the original 4-unit request returns the original complete response.
Its user portion still looks like this after the plan update:

```json
{
  "consumed": 4,
  "remaining": 6,
  "plan": { "id": 5, "revision": 1 }
}
```

That portion is a historical snapshot, not the full replay response. The stored
decision's stored `evaluatedLimits.user` still contains `monthlyLimit: 10` and
`maxUnitsPerRequest: 5`; inspection now shows monthly limit 20 and revision 2.
Current rules are never joined into or substituted for a replayed decision.
The updated definition applies to new request IDs immediately, without a restart.

`PATCH /account/plan` and `PATCH /users/:id/plan` can switch to another eligible
owned or predefined plan. The next inspection reflects the new assignment,
while consumed units and old decisions remain intact. Scope mismatches return
`422 PLAN_SCOPE_MISMATCH`, foreign plans return `404 PLAN_NOT_FOUND`, and edits
to predefined plans return `403 PREDEFINED_PLAN_READ_ONLY`.

Use `GET /plans`, `GET /plans?scope=user`, or `GET /plans/:id` to inspect the
available definitions. Only the four predefined plans and the authenticated
account's custom plans are visible. Catalog responses use `requestLimit` for
the same per-request value named `maxUnitsPerRequest` in assigned-plan/rules
responses.

## Custom plans

The plan catalog contains the four global predefined plans plus custom plans
owned by the authenticated account. Predefined plans are readable by every
account and cannot be modified. Custom plans are visible and mutable only to
their owner.

Create an account-scope custom plan:

```bash
curl -X POST http://localhost:3000/plans \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Account Burst","scope":"account","monthlyLimit":30,"requestLimit":100}'
```

The response is `201 Created`:

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

List every visible plan, or filter by scope:

```bash
curl http://localhost:3000/plans -H "X-API-Key: ${API_KEY}"
curl "http://localhost:3000/plans?scope=user" -H "X-API-Key: ${API_KEY}"
curl http://localhost:3000/plans/5 -H "X-API-Key: ${API_KEY}"
```

Update the mutable fields of an owned custom plan:

```bash
curl -X PATCH http://localhost:3000/plans/5 \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"monthlyLimit":50,"requestLimit":20}'
```

Every successful update increments `revision` exactly once. `scope` and owner
are immutable. Updating a plan changes its shared definition but does not alter
assignments, usage rows, or historical decision snapshots. Reading or updating
another account's custom plan returns the same `404 PLAN_NOT_FOUND` response as
an unknown ID. Updating a predefined plan returns
`403 PREDEFINED_PLAN_READ_ONLY`.

## Plan assignment

Assign a visible account-scope plan to the authenticated account:

```bash
curl -X PATCH http://localhost:3000/account/plan \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"planId":5}'
```

Assign a visible user-scope plan to an owned user:

```bash
curl -X PATCH http://localhost:3000/users/replace-with-user-id/plan \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"planId":6}'
```

The assignment responses contain the account or user with the newly applied
plan. Later `GET /account` and `GET /users/:id` calls read the current plan
definition, including its limits and revision.

Assignments accept global predefined plans and custom plans owned by the
authenticated account. A visible plan with the wrong scope returns
`422 PLAN_SCOPE_MISMATCH`. A missing or foreign plan returns
`404 PLAN_NOT_FOUND`, and a missing or foreign user returns
`404 USER_NOT_FOUND`.

Plan switches take the same account lock used by custom-plan updates. Switching
changes only the subject's plan reference: it does not reset monthly usage or
rewrite historical decision rows and snapshots. Multiple users may reference
one custom plan, and later edits to that shared definition appear through both
users' inspection responses.

### Plan changes racing with consumption

Plan edits, account/user assignment switches, and consumption use the same
account-first row lock. A mutation returns success only after commit. A new
consumption reads fresh assignments and plan definitions after obtaining that
lock, so lock acquisition order determines which rules apply—not HTTP arrival
time.

If a monthly limit changes from 10 to 5 before a waiting 6-unit request obtains
the lock, that request rejects and records the new revision. If consumption
obtains the lock first, its 6-unit acceptance under limit 10 remains valid after
the downgrade. Usage stays at 6 and new positive requests reject with remaining
clamped to zero. Raising the limit makes only the difference available; it never
resets consumption. These semantics apply to both account and user limits.

Custom-plan edits increment revision once per successful update. Assignment
switches select another plan without changing its revision. Shared user-plan
edits affect every assigned user's new decisions, not their individual totals.
Previously accepted and rejected IDs always retain their original snapshots.

## Consumption contract

`POST /consume` is an authenticated tenant route with this strict request:

```json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "doc-2026:01"
}
```

Use the UUID returned by `POST /users`; the UUIDs and timestamps below are
illustrative. For example:

```bash
curl -X POST http://localhost:3000/consume \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"userId":"replace-with-owned-user-uuid","units":4,"requestId":"doc-2026:01"}'
```

The API derives the account from `X-API-Key`; `accountId` is not accepted in
the body. A completed accepted decision returns `200`:

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

A valid quota rejection is also a completed `200` decision. Its balances are
unchanged and `blockedBy` explains the first blocking rule. After the accepted
4-unit example above, a new 25-unit request exceeds Basic's 20-unit request cap:

```json
{
  "requestId": "doc-2026:02",
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 25,
  "accepted": false,
  "processedAt": "2026-10-16T12:31:00.000Z",
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
  "blockedBy": {
    "scope": "user",
    "rule": "max_units_per_request",
    "limit": 20
  }
}
```

The other possible blocking rule is `monthly_limit`; either rule has an
`account` or `user` scope. Every `account`/`user` consumed and remaining value,
applied plan ID/revision, and blocker is a **value at decision time**, identified
by `processedAt`. These are historical snapshots, not live balance queries,
and will not be recalculated on a later replay. Accepted balances include the
requested units; rejected balances describe unchanged consumption.

Each stored `decision_snapshot` contains the public body under `response` and
the evaluated rule values under `evaluatedLimits`. For the predefined plans in
these examples, those rule values (also exposed by history) are:

```json
{
  "account": { "monthlyLimit": 10000, "maxUnitsPerRequest": 100 },
  "user": { "monthlyLimit": 1000, "maxUnitsPerRequest": 20 }
}
```

The database row also retains the account/request/user identity, units, timestamp,
UTC month, outcome, blocker, and both plan IDs/revisions. The snapshot is
validated before insertion and on replay. The public body comes from that
snapshot's `response`, after commit, without a later query mixing in newer usage
or mutable plan settings. Plan edits and assignments do not rewrite old decisions.
There are no HTTP update/delete operations for decision history. A failed
transaction returns a safe API error instead of an accepted response.

### Safe retries

`requestId` is an exact, case-sensitive identifier scoped to the authenticated
account, across all of its users and months. PostgreSQL enforces
`PRIMARY KEY (account_id, request_id)`. IDs and decision history are retained for
the life of the project, with no expiry or automatic reuse.

After authentication, validation, ownership checking, and the account lock:

- The same ID, normalized UUID, and numeric units return the original `200`
  body for both acceptance and quota rejection. JSON property order and UUID
  letter case do not change this comparison.
- Different units or another owned user with the same ID return
  `409 REQUEST_ID_CONFLICT`, without another charge or replacement decision.
  A foreign/missing user still returns `404 USER_NOT_FOUND`, not stored data.
- Another account can use the same ID independently with its own user/key.

A replay does not reevaluate plans, capture a new processing time, or initialize
monthly buckets. Its timestamp, month, blocker, revisions, and balances remain
historical, and stored evaluated limits are unchanged. Application restarts,
later consumption, plan changes, and month rollover do not reset the ID. HTTP
correlation headers may differ; the business response does not.

For example: request 6 units under ID `doc-1` with a user request cap of 5. The
rejection is saved. Raising the cap to 10 does not change a retry of `doc-1`:
it still reports the original rejection and cap 5. Use a new ID such as `doc-2`
for a new decision. If a response is lost after commit, retry the **same** ID
and payload to recover it safely; a new ID would represent another action.

Authentication, validation, and ownership failures do not reserve a new ID.
A rolled-back transaction also leaves no decision, so the same ID can be tried
again. These checks still apply when retrying an already recorded request.

Task 16 defines and validates this stable HTTP boundary. Task 17 implements
the pure four-rule evaluator, including first-blocker precedence and proposed
balances. Task 18 adds UTC month normalization and account/user usage bucket
storage. Task 19 implements the atomic consumption service, including both usage
updates and the decision insert in one transaction. Task 20 connects the
production `POST /consume` route and verifies its complete snapshot contract.
Task 21 verifies sequential retries and conflicts. Task 22 verifies simultaneous
last-unit consumption, duplicate/conflicting IDs, and independent accounts
against a separate PostgreSQL test database. Task 23 verifies live-plan edits,
assignment changes, downgrades, and controlled mutation/consumption ordering.
Task 24 verifies UTC rollover, lock waits across midnight, one accounting instant
per decision, year/offset boundaries, and historical cross-month retries.
Task 25 verifies failure rollback, same-ID recovery, and actual API/PostgreSQL
restarts in an isolated stack. Tasks 26–28 add usage queries, current-rule
inspection, and paginated history; performance work and delivery checks remain
separate milestones.

### Failures and uncertain responses

An internal/database failure before commit returns `500 INTERNAL_ERROR` with a
correlation ID and generic message, never an accepted response or a quota-denial
decision. Rollback removes the attempt's counter changes and decision together;
the same ID can subsequently complete normally. Error responses omit raw API
keys, connection credentials, SQL statements, and internal database errors.

If the database commits but the response is lost, retry the same ID and payload.
The saved response is durable and replays without another charge. A timeout alone
cannot tell the caller whether commit happened; retrying with a new ID risks
representing another action.

Original account keys, plans, assignments, usage, and accepted/rejected snapshots
survive API and PostgreSQL restarts while their database volume is retained and
the same key pepper is used. The reproducible isolated check is
`npm run test:reliability`; actual evidence is in `docs/reliability-results.md`.
It checks readiness before retrying after restart and confirms new writes work
after recovery. It is not a guarantee of uninterrupted service during an outage.

### Accounting time and month selection

For a new decision, `processedAt` is captured once after the account lock is
acquired, using a separate PostgreSQL `statement_timestamp()` query in production.
That instant determines the UTC month for both usage totals and the decision.
Arrival time, transaction-start time, local timezones, and response-delivery time
do not determine the month. There is no client-supplied clock or processing-time
field.

A request that waits across midnight into November is accounted entirely in
November. A request whose processing time was captured in October remains
entirely in October even if writes finish after midnight. New-month usage starts
at zero without deleting previous months. For example, 4 units immediately before
November and 3 at November's first instant leave October=4 and November=3.

Replaying October's ID in November returns the original October response and
does not create or change November buckets. A new ID is needed for a new action.
For offset timestamps in internal tests, `2026-11-01T01:30:00+03:00` is
`2026-10-31T22:30:00Z`, so its accounting month is October.

## Error envelope

Every HTTP error has a stable code and a server-generated correlation ID:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request body is invalid."
  },
  "correlationId": "req-1"
}
```

Malformed JSON uses a distinct code because parsing failed before domain-body
validation:

```json
{
  "error": {
    "code": "INVALID_JSON",
    "message": "Request body must be valid JSON."
  },
  "correlationId": "req-2"
}
```

| Status | Stable code | Meaning |
| ---: | --- | --- |
| 400 | `INVALID_JSON` | The body is not valid JSON. |
| 400 | `INVALID_REQUEST` | A field is missing, unknown, has the wrong type, or is outside its bound. |
| 401 | `UNAUTHORIZED` | The API key is missing or invalid. |
| 403 | `PREDEFINED_PLAN_READ_ONLY` | A predefined plan cannot be edited. |
| 404 | `USER_NOT_FOUND` or `PLAN_NOT_FOUND` | The resource is missing or belongs to another account. |
| 409 | `REQUEST_ID_CONFLICT` | The account already used the request ID with a different payload. |
| 422 | `PLAN_SCOPE_MISMATCH` | A visible plan has the wrong account/user scope for an assignment. |
| 500 | `INTERNAL_ERROR` | An unexpected failure; no successful consumption result is reported. Retry an uncertain consume attempt with its original ID and payload. |
| 503 | `DATABASE_UNAVAILABLE` | `GET /health` cannot verify PostgreSQL connectivity. |

Responses never include validation-library internals, SQL, connection strings,
or stack traces.

## Quota rejection is not invalid input

A syntactically valid, authenticated, owned-user consumption request reaches
quota evaluation. Whether accepted or quota-rejected, it returns `200` with an
`accepted` value and an explicit decision reason, and becomes immutable
decision history. Authentication failures, malformed or invalid bodies,
missing or foreign users, and request-ID conflicts do not create a consumption
decision or alter usage.
