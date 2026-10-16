import { createHmac, randomBytes } from "node:crypto";

const API_KEY_RANDOM_BYTES = 32;
const API_KEY_PREFIX = "umq_";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(API_KEY_RANDOM_BYTES).toString("base64url")}`;
}

export function digestApiKey(apiKey: string, pepper: string): string {
  return createHmac("sha256", pepper).update(apiKey, "utf8").digest("hex");
}
