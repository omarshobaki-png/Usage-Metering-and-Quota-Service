import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../../src/config.js";
import { verifyConfigurationTargets, type ConfigurationTargets } from "../../src/config-consistency.js";

const targets: ConfigurationTargets = {
  localPepper: "shared-test-pepper-secret",
  apiPepper: "shared-test-pepper-secret",
  initPepper: "shared-test-pepper-secret",
  localDatabasePort: 55432, publishedDatabasePort: 55432
};

describe("local/Compose configuration consistency", () => {
  it("accepts one shared pepper and matching database ports", () => {
    expect(() => verifyConfigurationTargets(targets)).not.toThrow();
  });
  it.each(["apiPepper", "initPepper"] as const)("rejects a hardcoded/different %s without exposing either secret", (field) => {
    try {
      verifyConfigurationTargets({ ...targets, [field]: "old-hardcoded-secret" });
      expect.fail("Expected a configuration mismatch.");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).toContain("API_KEY_PEPPER");
      expect((error as Error).message).not.toContain(targets.localPepper);
      expect((error as Error).message).not.toContain("old-hardcoded-secret");
    }
  });
  it.each(["apiPepper", "initPepper"] as const)("rejects an absent %s", (field) => {
    expect(() => verifyConfigurationTargets({ ...targets, [field]: undefined })).toThrow(ConfigurationError);
  });
  it("accepts an already-running API with the shared pepper", () => {
    expect(() => verifyConfigurationTargets({ ...targets, runningApiPepper: targets.localPepper })).not.toThrow();
  });
  it("detects a stale running container and tells the caller to recreate it", () => {
    expect(() => verifyConfigurationTargets({ ...targets, runningApiPepper: "stale-container-secret" }))
      .toThrow(/running API.*Recreate/);
  });
  it("detects the 55432 versus 5432 mismatch before connection-refused test failures", () => {
    expect(() => verifyConfigurationTargets({ ...targets, publishedDatabasePort: 5432 }))
      .toThrow(/DATABASE_URL uses port 55432.*5432/);
  });
});
