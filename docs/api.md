# API validation and errors

All tenant endpoints authenticate with `X-API-Key`. The authenticated key is the
only source of account ownership; request bodies never accept `accountId`.

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

## Consumption contract

`POST /consume` is an authenticated tenant route with this strict request:

```json
{
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 4,
  "requestId": "doc-2026:01"
}
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
unchanged and `blockedBy` explains the first blocking rule:

```json
{
  "requestId": "doc-2026:02",
  "userId": "00000000-0000-4000-8000-000000000020",
  "units": 6,
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
    "limit": 5
  }
}
```

The other possible blocking rule is `monthly_limit`; either rule has an
`account` or `user` scope. `processedAt`, balances, and applied plan references
are decision-time snapshots and will not be recalculated on a later replay.

Task 16 defines and validates this stable HTTP boundary. The real evaluator,
usage mutation, decision persistence, and replay implementation follow in
Tasks 17–21; the production server does not expose fake accounting while those
pieces are unfinished.

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

Responses never include validation-library internals, SQL, connection strings,
or stack traces.

## Quota rejection is not invalid input

A syntactically valid, authenticated, owned-user consumption request reaches
quota evaluation. Whether accepted or quota-rejected, it returns `200` with an
`accepted` value and an explicit decision reason, and becomes immutable
decision history. Authentication failures, malformed or invalid bodies,
missing or foreign users, and request-ID conflicts do not create a consumption
decision or alter usage.
