import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { normalizeServiceUrl } from "../demo/client.js";

export interface LoadOptions {
  workload: "throughput" | "correctness";
  baseUrl: string;
  accounts: number;
  usersPerAccount: number;
  concurrency: number;
  requests: number;
  timeoutMs: number;
  monthlyLimit?: number;
  output?: string;
}

function integer(value: string, name: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return Number(value);
}

export function parseLoadOptions(args: string[], environment: NodeJS.ProcessEnv = process.env): LoadOptions {
  const { values } = parseArgs({ args, strict: true, options: {
    workload: { type: "string", default: "throughput" },
    "base-url": { type: "string" },
    accounts: { type: "string", default: "1" },
    "users-per-account": { type: "string", default: "2" },
    concurrency: { type: "string", default: "10" },
    requests: { type: "string" },
    "timeout-ms": { type: "string", default: "10000" },
    "monthly-limit": { type: "string" },
    output: { type: "string" }
  } });
  if (values.workload !== "throughput" && values.workload !== "correctness") {
    throw new Error("workload must be throughput or correctness.");
  }
  const accounts = integer(values.accounts, "accounts", 100);
  const requests = integer(values.requests ?? (values.workload === "correctness" ? "200" : "1000"), "requests", 100_000);
  if (accounts > requests) throw new Error("accounts cannot exceed requests.");
  if (values.workload === "correctness" && (accounts !== 1 || requests !== 200)) {
    throw new Error("The correctness workload requires exactly 1 account and 200 requests.");
  }
  if (values.output !== undefined && !values.output.endsWith(".json")) {
    throw new Error("output must name a .json result file.");
  }
  const monthlyLimit = values["monthly-limit"] === undefined ? undefined : integer(values["monthly-limit"], "monthly-limit", 1_000_000);
  if (monthlyLimit !== undefined && (values.workload !== "throughput" || monthlyLimit < requests)) {
    throw new Error("monthly-limit is throughput-only and must cover all requests.");
  }
  return {
    workload: values.workload,
    baseUrl: normalizeServiceUrl(values["base-url"] ?? environment.PERF_BASE_URL ?? "http://127.0.0.1:3000"),
    accounts,
    usersPerAccount: integer(values["users-per-account"], "users-per-account", 100),
    concurrency: integer(values.concurrency, "concurrency", 512),
    requests,
    timeoutMs: integer(values["timeout-ms"], "timeout-ms", 120_000),
    ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
    ...(values.output === undefined ? {} : { output: resolve(values.output) })
  };
}

export const loadHelp = `Usage: npm run perf -- [options]
  --workload throughput|correctness  Default: throughput
  --base-url HTTP_ORIGIN            Default: PERF_BASE_URL or http://127.0.0.1:3000
  --accounts N                      Default: 1 (correctness requires 1)
  --users-per-account N             Default: 2
  --requests N                      Default: 1000 (correctness requires 200)
  --concurrency N                   Default: 10; fixed bounded workers
  --timeout-ms N                    Default: 10000 per attempt; no retries
  --monthly-limit N                 Throughput only; >= requests (default: requests)
  --output PATH.json                Default: unique file in performance/results/
Requires DATABASE_URL and API_KEY_PEPPER for fresh local-only fixture setup and
read-only PostgreSQL reconciliation. API keys are generated and kept in memory.
`;
