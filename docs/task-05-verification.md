# Task 5 verification record

Date: 2026-10-13

## Automated checks

The following commands completed successfully:

```text
npm run typecheck
npm test -- --run
npm run build
```

Vitest reported two passing test files and six passing tests. The HTTP smoke suite covers a healthy database, an unavailable database, an unknown route, malformed JSON, and redaction of `X-API-Key` and `Authorization` values from captured logs.

## Docker Compose and health

The stack was rebuilt and started with:

```text
docker compose up --build -d --wait
```

Compose reported both `db` and `api` as healthy. A real request to the published API port returned:

```http
HTTP/1.1 200 OK
x-request-id: req-4
content-type: application/json; charset=utf-8

{"status":"ok","database":"reachable"}
```

PostgreSQL was then stopped temporarily while the API remained running. The same request returned a safe dependency failure:

```http
HTTP/1.1 503 Service Unavailable
x-request-id: req-9
content-type: application/json; charset=utf-8

{"status":"unhealthy","database":"unreachable","error":{"code":"DATABASE_UNAVAILABLE","message":"The database is currently unavailable."},"correlationId":"req-9"}
```

PostgreSQL was restored after this check.

## Graceful shutdown

Running `docker compose stop api` delivered `SIGTERM` directly to the Node process. The application log confirmed both phases:

```text
{"signal":"SIGTERM","msg":"Graceful shutdown started"}
{"signal":"SIGTERM","msg":"Graceful shutdown complete"}
```

Fastify closes its HTTP listener first, and its `onClose` hook then closes the PostgreSQL pool. The API was restarted after this check, and both Compose services returned to healthy status.
