import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { verifyConfigurationTargets } from "../src/config-consistency.js";

const root = fileURLToPath(new URL("../", import.meta.url));
function docker(args: string[]): string {
  try {
    return execFileSync("docker", args, {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
    }).trim();
  } catch {
    // Compose config/inspect may contain secrets. Never dump their output/errors.
    throw new Error("Could not inspect local Compose configuration. Check Docker availability and required .env settings.");
  }
}

try {
  const config = loadConfig();
  const compose = JSON.parse(docker(["compose", "config", "--format", "json"])) as {
    services: {
      api: { environment: { API_KEY_PEPPER?: string } };
      init: { environment: { API_KEY_PEPPER?: string } };
      db: { ports: { target: number; published: string | number }[] };
    };
  };
  let localUrl: URL;
  try { localUrl = new URL(config.DATABASE_URL); }
  catch { throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL."); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(localUrl.hostname)) {
    throw new Error("This local Compose check expects DATABASE_URL to use localhost/127.0.0.1/::1 and the published PostgreSQL port.");
  }
  const published = compose.services.db.ports.find((entry) => entry.target === 5432)?.published;
  if (published === undefined) throw new Error("Compose does not publish the PostgreSQL port.");
  const targets = {
    localPepper: config.API_KEY_PEPPER,
    apiPepper: compose.services.api.environment.API_KEY_PEPPER,
    initPepper: compose.services.init.environment.API_KEY_PEPPER,
    localDatabasePort: Number(localUrl.port || 5432),
    publishedDatabasePort: Number(published)
  };
  verifyConfigurationTargets(targets);
  const containerId = docker(["compose", "ps", "-q", "api"]);
  if (containerId !== "") {
    const inspected = JSON.parse(docker(["inspect", containerId])) as { Config: { Env: string[] } }[];
    const entry = inspected[0]?.Config.Env.find((value) => value.startsWith("API_KEY_PEPPER="));
    verifyConfigurationTargets({ ...targets, runningApiPepper: entry?.slice("API_KEY_PEPPER=".length) });
  }
  console.log("Configuration OK: local commands and Compose api/init use the same API-key pepper.");
  console.log(`Database ports match: ${targets.localDatabasePort}.`);
  console.log(containerId === "" ? "API not running yet; start it with docker compose up -d --build --wait." : "Running API pepper also matches; no credential values printed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Configuration check failed.");
  process.exitCode = 1;
}
