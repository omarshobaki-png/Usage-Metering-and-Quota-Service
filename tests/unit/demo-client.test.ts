import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DemoApiClient,
  DemoApiError,
  DemoConfigurationError,
  loadDemoClientConfig,
  normalizeServiceUrl
} from "../../demo/client.js";

const validEnvironment = {
  DEMO_SERVICE_URL: "http://127.0.0.1:3000",
  DEMO_API_KEY: `umq_${"a".repeat(43)}`,
  DEMO_ACCOUNT_PLAN_ID: "5",
  DEMO_BASIC_USER_ID: "11111111-1111-4111-8111-111111111111",
  DEMO_PREMIUM_USER_ID: "22222222-2222-4222-8222-222222222222"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo client configuration and failures", () => {
  it("loads separate environment configuration without changing the service origin", () => {
    expect(loadDemoClientConfig(validEnvironment)).toEqual({
      serviceUrl: "http://127.0.0.1:3000",
      apiKey: validEnvironment.DEMO_API_KEY,
      accountPlanId: 5,
      basicUserId: validEnvironment.DEMO_BASIC_USER_ID,
      premiumUserId: validEnvironment.DEMO_PREMIUM_USER_ID
    });
    expect(normalizeServiceUrl("https://quota.example.test/")).toBe(
      "https://quota.example.test"
    );
  });

  it("rejects unsafe or incomplete configuration without echoing a key", () => {
    expect(() =>
      normalizeServiceUrl("https://secret@example.test/api?key=value")
    ).toThrow(DemoConfigurationError);
    expect(() =>
      loadDemoClientConfig({ ...validEnvironment, DEMO_BASIC_USER_ID: undefined })
    ).toThrow("DEMO_BASIC_USER_ID is required");
    expect(() =>
      loadDemoClientConfig({ ...validEnvironment, DEMO_API_KEY: "not-a-key" })
    ).toThrow("DEMO_API_KEY has an invalid format");
  });

  it("surfaces a useful API error without including the raw key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "UNAUTHORIZED", message: "A valid API key is required." },
            correlationId: "request-123"
          }),
          { status: 401, headers: { "content-type": "application/json" } }
        )
      )
    );
    const client = new DemoApiClient({
      serviceUrl: validEnvironment.DEMO_SERVICE_URL,
      apiKey: validEnvironment.DEMO_API_KEY
    });

    const failure = await client.createUser(3).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DemoApiError);
    expect(String(failure)).toContain("401 UNAUTHORIZED");
    expect(String(failure)).toContain("correlationId=request-123");
    expect(String(failure)).not.toContain(validEnvironment.DEMO_API_KEY);
  });
});
