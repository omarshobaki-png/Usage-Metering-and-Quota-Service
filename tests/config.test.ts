import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reports a named configuration error when DATABASE_URL is missing", () => {
    try {
      loadConfig({});
      expect.fail("Expected loadConfig to reject a missing DATABASE_URL");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({
        name: "ConfigurationError",
        message: expect.stringContaining("DATABASE_URL")
      });
    }
  });

  it("reports a named configuration error when API_KEY_PEPPER is missing", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://example.test/database"
      })
    ).toThrow(/API_KEY_PEPPER/);
  });

  it("accepts the required database URL and API-key pepper", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://example.test/database",
        API_KEY_PEPPER: "a-test-pepper-value"
      })
    ).toMatchObject({
      DATABASE_URL: "postgres://example.test/database",
      API_KEY_PEPPER: "a-test-pepper-value"
    });
  });
});
