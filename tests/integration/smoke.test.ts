import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

function track(app: ReturnType<typeof buildApp>) {
  apps.push(app);
  return app;
}

const rejectAuthentication = async () => null;
const unusedUserOperations = {
  createUser: async () => {
    throw new Error("User creation is not used by this test.");
  },
  getUser: async () => null
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("HTTP smoke behavior", () => {
  it("returns 200 when the database health check succeeds", async () => {
    const app = track(
      buildApp({
        checkDatabase: async () => undefined,
        authenticateAccount: rejectAuthentication,
        userOperations: unusedUserOperations,
        logger: false
      })
    );

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", database: "reachable" });
  });

  it("returns a safe 503 when the database health check fails", async () => {
    const app = track(
      buildApp({
        checkDatabase: async () => {
          throw new Error("SELECT secret at postgres://user:password@db");
        },
        authenticateAccount: rejectAuthentication,
        userOperations: unusedUserOperations,
        logger: false
      })
    );

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "unhealthy",
      database: "unreachable",
      error: {
        code: "DATABASE_UNAVAILABLE",
        message: "The database is currently unavailable."
      }
    });
    expect(response.body).not.toContain("SELECT secret");
    expect(response.body).not.toContain("postgres://");
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("stack");
  });

  it("returns the shared JSON envelope for an unknown route", async () => {
    const app = track(
      buildApp({
        checkDatabase: async () => undefined,
        authenticateAccount: rejectAuthentication,
        userOperations: unusedUserOperations,
        logger: false
      })
    );

    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Route not found." },
      correlationId: expect.any(String)
    });
  });

  it("returns a safe JSON 400 response for malformed JSON", async () => {
    const app = track(
      buildApp({
        checkDatabase: async () => undefined,
        authenticateAccount: rejectAuthentication,
        userOperations: unusedUserOperations,
        logger: false
      })
    );
    app.post("/test-json-parser", async (request) => request.body);

    const response = await app.inject({
      method: "POST",
      url: "/test-json-parser",
      headers: { "content-type": "application/json" },
      payload: '{"broken":'
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON."
      },
      correlationId: expect.any(String)
    });
    expect(response.body).not.toContain("stack");
  });

  it("redacts API key and authorization values from logs", async () => {
    const logLines: string[] = [];
    const app = track(
      buildApp({
        checkDatabase: async () => undefined,
        authenticateAccount: rejectAuthentication,
        userOperations: unusedUserOperations,
        logger: {
          stream: {
            write(message: string) {
              logLines.push(message);
            }
          }
        }
      })
    );

    app.get("/test-log-redaction", async (request) => {
      request.log.info({ headers: request.headers }, "test request headers");
      return { status: "ok" };
    });

    await app.inject({
      method: "GET",
      url: "/test-log-redaction",
      headers: {
        "x-api-key": "dummy-api-key-secret",
        authorization: "Bearer dummy-authorization-secret"
      }
    });

    const logs = logLines.join("");
    expect(logs).toContain("[REDACTED]");
    expect(logs).not.toContain("dummy-api-key-secret");
    expect(logs).not.toContain("dummy-authorization-secret");
  });
});
