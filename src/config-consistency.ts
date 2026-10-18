import { ConfigurationError } from "./config.js";

export interface ConfigurationTargets {
  localPepper: string;
  apiPepper: string | undefined;
  initPepper: string | undefined;
  runningApiPepper?: string | undefined;
  localDatabasePort: number;
  publishedDatabasePort: number;
}

/** Never include pepper values or database credentials in diagnostic messages. */
export function verifyConfigurationTargets(targets: ConfigurationTargets): void {
  for (const [name, pepper] of [["api", targets.apiPepper], ["init", targets.initPepper]] as const) {
    if (pepper !== targets.localPepper) {
      throw new ConfigurationError(
        `Compose ${name} API_KEY_PEPPER differs from the local configuration. Use the shared API_KEY_PEPPER setting; do not change issued keys.`
      );
    }
  }
  if ("runningApiPepper" in targets && targets.runningApiPepper !== targets.localPepper) {
    throw new ConfigurationError(
      "The running API has an older/different API_KEY_PEPPER. Recreate it with docker compose up -d --no-deps --wait api."
    );
  }
  if (targets.localDatabasePort !== targets.publishedDatabasePort) {
    throw new ConfigurationError(
      `DATABASE_URL uses port ${targets.localDatabasePort}, but Compose publishes PostgreSQL on ${targets.publishedDatabasePort}. Keep POSTGRES_PORT and DATABASE_URL in sync.`
    );
  }
}
