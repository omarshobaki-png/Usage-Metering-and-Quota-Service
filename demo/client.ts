import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseConsumptionDecision, type ConsumptionDecision } from "../src/modules/usage/contract.js";
import { planIdSchema, userIdSchema } from "../src/shared/validation.js";

const API_KEY_PATTERN = /^umq_[A-Za-z0-9_-]{43}$/;

export const DEMO_REQUEST_IDS = {
  basicFour: "demo-basic-4",
  basicSix: "demo-basic-6",
  premiumTwenty: "demo-premium-20",
  premiumSevenBeforeUpgrade: "demo-premium-7-before-upgrade",
  premiumSevenAfterUpgrade: "demo-premium-7-after-upgrade"
} as const;

export interface DemoClientConfig {
  serviceUrl: string;
  apiKey: string;
  accountPlanId: number;
  basicUserId: string;
  premiumUserId: string;
}

export interface DemoPlan {
  id: number;
  name: string;
  scope: "account" | "user";
  monthlyLimit: number;
  requestLimit: number;
  revision: number;
  owner: "predefined" | "account";
}

export interface DemoUser {
  id: string;
  accountId: string;
  plan: {
    id: number;
    name: string;
    scope: "account" | "user";
    monthlyLimit: number;
    maxUnitsPerRequest: number;
    revision: number;
  };
}

interface CurrentBalance {
  id: string;
  consumed: number;
  monthlyLimit: number;
  remaining: number;
}

interface CurrentUserUsage {
  month: string;
  isCurrentMonth: true;
  account: CurrentBalance;
  user: CurrentBalance;
}

interface ApiErrorEnvelope {
  error?: { code?: unknown; message?: unknown };
  correlationId?: unknown;
}

export class DemoConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DemoConfigurationError";
  }
}

export class DemoApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly correlationId?: string
  ) {
    super(
      `Demo API request failed (${statusCode} ${code}): ${message}` +
        (correlationId === undefined ? "" : ` [correlationId=${correlationId}]`)
    );
    this.name = "DemoApiError";
  }
}

export function normalizeServiceUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new DemoConfigurationError("DEMO_SERVICE_URL must be a valid HTTP or HTTPS origin.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new DemoConfigurationError(
      "DEMO_SERVICE_URL must be an HTTP or HTTPS origin without credentials, a path, query, or fragment."
    );
  }

  return url.origin;
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];

  if (value === undefined || value.trim() === "") {
    throw new DemoConfigurationError(
      `${name} is required. Run npm run demo:setup before npm run demo:run.`
    );
  }

  return value.trim();
}

function environmentPlanId(environment: NodeJS.ProcessEnv): number {
  const raw = requiredEnvironmentValue(environment, "DEMO_ACCOUNT_PLAN_ID");

  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DemoConfigurationError("DEMO_ACCOUNT_PLAN_ID must be a positive integer.");
  }

  const value = Number(raw);
  if (!planIdSchema.safeParse(value).success) {
    throw new DemoConfigurationError("DEMO_ACCOUNT_PLAN_ID is outside the supported range.");
  }

  return value;
}

function environmentUserId(environment: NodeJS.ProcessEnv, name: string): string {
  const value = requiredEnvironmentValue(environment, name).toLowerCase();

  if (!userIdSchema.safeParse(value).success) {
    throw new DemoConfigurationError(`${name} must be a UUID.`);
  }

  return value;
}

export function loadDemoClientConfig(
  environment: NodeJS.ProcessEnv = process.env
): DemoClientConfig {
  const apiKey = requiredEnvironmentValue(environment, "DEMO_API_KEY");

  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new DemoConfigurationError("DEMO_API_KEY has an invalid format.");
  }

  return {
    serviceUrl: normalizeServiceUrl(
      requiredEnvironmentValue(environment, "DEMO_SERVICE_URL")
    ),
    apiKey,
    accountPlanId: environmentPlanId(environment),
    basicUserId: environmentUserId(environment, "DEMO_BASIC_USER_ID"),
    premiumUserId: environmentUserId(environment, "DEMO_PREMIUM_USER_ID")
  };
}

export class DemoApiClient {
  public constructor(private readonly config: Pick<DemoClientConfig, "serviceUrl" | "apiKey">) {}

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PATCH" = "GET",
    body?: unknown
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.config.serviceUrl}${path}`, {
        method,
        headers: {
          "x-api-key": this.config.apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new DemoApiError(
        0,
        "SERVICE_UNAVAILABLE",
        error instanceof Error ? error.message : "The service could not be reached."
      );
    }

    const text = await response.text();
    let payload: unknown;

    try {
      payload = text === "" ? null : JSON.parse(text);
    } catch {
      throw new DemoApiError(
        response.status,
        "INVALID_RESPONSE",
        "The service returned a non-JSON response."
      );
    }

    if (!response.ok) {
      const envelope = payload as ApiErrorEnvelope | null;
      const code =
        typeof envelope?.error?.code === "string"
          ? envelope.error.code
          : "HTTP_ERROR";
      const message =
        typeof envelope?.error?.message === "string"
          ? envelope.error.message
          : "The service rejected the request.";
      const correlationId =
        typeof envelope?.correlationId === "string"
          ? envelope.correlationId
          : undefined;

      throw new DemoApiError(response.status, code, message, correlationId);
    }

    return payload as T;
  }

  public async createPlan(input: {
    name: string;
    scope: "account" | "user";
    monthlyLimit: number;
    requestLimit: number;
  }): Promise<DemoPlan> {
    return (await this.request<{ plan: DemoPlan }>("/plans", "POST", input)).plan;
  }

  public async updatePlan(
    planId: number,
    input: { monthlyLimit: number }
  ): Promise<DemoPlan> {
    return (
      await this.request<{ plan: DemoPlan }>(`/plans/${planId}`, "PATCH", input)
    ).plan;
  }

  public async assignAccountPlan(planId: number): Promise<void> {
    await this.request("/account/plan", "PATCH", { planId });
  }

  public async createUser(planId: number): Promise<DemoUser> {
    return (await this.request<{ user: DemoUser }>("/users", "POST", { planId })).user;
  }

  public async consume(input: {
    userId: string;
    units: number;
    requestId: string;
  }): Promise<ConsumptionDecision> {
    return parseConsumptionDecision(
      await this.request("/consume", "POST", input)
    );
  }

  public async readUserUsage(userId: string): Promise<CurrentUserUsage> {
    return this.request<CurrentUserUsage>(`/users/${userId}/usage`);
  }
}

interface ExpectedDecision {
  accepted: boolean;
  accountConsumed: number;
  accountRemaining: number;
  userConsumed: number;
  userRemaining: number;
  blockingScope?: "account" | "user";
  blockingRule?: "max_units_per_request" | "monthly_limit";
}

function requireDecision(
  decision: ConsumptionDecision,
  expected: ExpectedDecision
): void {
  const blockerMismatch = expected.accepted
    ? decision.blockedBy !== null
    : decision.blockedBy === null ||
      decision.blockedBy.scope !== expected.blockingScope ||
      decision.blockedBy.rule !== expected.blockingRule;
  const mismatch =
    decision.accepted !== expected.accepted ||
    decision.account.consumed !== expected.accountConsumed ||
    decision.account.remaining !== expected.accountRemaining ||
    decision.user.consumed !== expected.userConsumed ||
    decision.user.remaining !== expected.userRemaining ||
    blockerMismatch;

  if (mismatch) {
    throw new Error(
      `Demo state did not match the fixed scenario at requestId=${decision.requestId}. Run npm run demo:setup to create a fresh fixture.`
    );
  }
}

export interface DemoRunOptions {
  log?: (message: string) => void;
  processDocument?: (userLabel: "Basic" | "Premium", units: number) => void | Promise<void>;
}

export interface DemoRunResult {
  newDecisions: ConsumptionDecision[];
  replay: ConsumptionDecision;
  liveUsage: CurrentUserUsage;
}

function printDecision(
  log: (message: string) => void,
  heading: string,
  userLabel: "Basic" | "Premium",
  decision: ConsumptionDecision
): void {
  log(heading);
  log(`  ${decision.accepted ? "ACCEPTED" : "REJECTED"} requestId=${decision.requestId}`);
  log(
    `  decision snapshot: account consumed=${decision.account.consumed} remaining=${decision.account.remaining}; ` +
      `${userLabel} consumed=${decision.user.consumed} remaining=${decision.user.remaining}`
  );

  if (decision.blockedBy !== null) {
    log(
      `  blocked by: scope=${decision.blockedBy.scope} rule=${decision.blockedBy.rule} limit=${decision.blockedBy.limit}`
    );
  }
}

async function runNewAction(
  api: DemoApiClient,
  log: (message: string) => void,
  processDocument: NonNullable<DemoRunOptions["processDocument"]>,
  heading: string,
  userLabel: "Basic" | "Premium",
  input: { userId: string; units: number; requestId: string },
  expected: ExpectedDecision
): Promise<ConsumptionDecision> {
  const decision = await api.consume(input);
  requireDecision(decision, expected);
  printDecision(log, heading, userLabel, decision);

  if (decision.accepted) {
    await processDocument(userLabel, input.units);
    log(`  simulated work: processed ${input.units} document unit(s) for ${userLabel}`);
  } else {
    log("  simulated work: skipped because quota rejected the request");
  }

  return decision;
}

export async function runDemoScenario(
  config: DemoClientConfig,
  options: DemoRunOptions = {}
): Promise<DemoRunResult> {
  const log = options.log ?? console.log;
  const processDocument = options.processDocument ?? (() => undefined);
  const api = new DemoApiClient(config);
  const newDecisions: ConsumptionDecision[] = [];

  log("Quota demo: five new decisions, one replay, then live usage");

  newDecisions.push(
    await runNewAction(
      api,
      log,
      processDocument,
      "1. Basic requests 4 units",
      "Basic",
      { userId: config.basicUserId, units: 4, requestId: DEMO_REQUEST_IDS.basicFour },
      {
        accepted: true,
        accountConsumed: 4,
        accountRemaining: 26,
        userConsumed: 4,
        userRemaining: 6
      }
    )
  );

  newDecisions.push(
    await runNewAction(
      api,
      log,
      processDocument,
      "2. Basic requests 6 units",
      "Basic",
      { userId: config.basicUserId, units: 6, requestId: DEMO_REQUEST_IDS.basicSix },
      {
        accepted: false,
        accountConsumed: 4,
        accountRemaining: 26,
        userConsumed: 4,
        userRemaining: 6,
        blockingScope: "user",
        blockingRule: "max_units_per_request"
      }
    )
  );

  newDecisions.push(
    await runNewAction(
      api,
      log,
      processDocument,
      "3. Premium requests 20 units",
      "Premium",
      {
        userId: config.premiumUserId,
        units: 20,
        requestId: DEMO_REQUEST_IDS.premiumTwenty
      },
      {
        accepted: true,
        accountConsumed: 24,
        accountRemaining: 6,
        userConsumed: 20,
        userRemaining: 10
      }
    )
  );

  const rejectedBeforeUpgrade = await runNewAction(
    api,
    log,
    processDocument,
    "4. Premium requests 7 units before the account upgrade",
    "Premium",
    {
      userId: config.premiumUserId,
      units: 7,
      requestId: DEMO_REQUEST_IDS.premiumSevenBeforeUpgrade
    },
    {
      accepted: false,
      accountConsumed: 24,
      accountRemaining: 6,
      userConsumed: 20,
      userRemaining: 10,
      blockingScope: "account",
      blockingRule: "monthly_limit"
    }
  );
  newDecisions.push(rejectedBeforeUpgrade);

  const updatedPlan = await api.updatePlan(config.accountPlanId, { monthlyLimit: 50 });
  if (updatedPlan.monthlyLimit !== 50) {
    throw new Error("Demo Account did not update to a 50-unit monthly limit.");
  }
  log("Plan change: updated Demo Account monthly limit from 30 to 50 through the API");

  newDecisions.push(
    await runNewAction(
      api,
      log,
      processDocument,
      "5. Premium requests 7 units with a NEW request ID",
      "Premium",
      {
        userId: config.premiumUserId,
        units: 7,
        requestId: DEMO_REQUEST_IDS.premiumSevenAfterUpgrade
      },
      {
        accepted: true,
        accountConsumed: 31,
        accountRemaining: 19,
        userConsumed: 27,
        userRemaining: 3
      }
    )
  );

  const replay = await api.consume({
    userId: config.premiumUserId,
    units: 7,
    requestId: DEMO_REQUEST_IDS.premiumSevenBeforeUpgrade
  });
  requireDecision(replay, {
    accepted: false,
    accountConsumed: 24,
    accountRemaining: 6,
    userConsumed: 20,
    userRemaining: 10,
    blockingScope: "account",
    blockingRule: "monthly_limit"
  });
  if (JSON.stringify(replay) !== JSON.stringify(rejectedBeforeUpgrade)) {
    throw new Error("The rejected request did not replay its original immutable snapshot.");
  }
  printDecision(
    log,
    "Replay: earlier rejected request ID (no new work)",
    "Premium",
    replay
  );

  const liveUsage = await api.readUserUsage(config.premiumUserId);
  if (
    liveUsage.isCurrentMonth !== true ||
    liveUsage.account.consumed !== 31 ||
    liveUsage.account.monthlyLimit !== 50 ||
    liveUsage.account.remaining !== 19 ||
    liveUsage.user.consumed !== 27 ||
    liveUsage.user.monthlyLimit !== 30 ||
    liveUsage.user.remaining !== 3
  ) {
    throw new Error("Live usage did not match the completed demo scenario.");
  }

  log("Live usage after replay (current counters, not the saved snapshot)");
  log(
    `  month=${liveUsage.month}; account consumed=${liveUsage.account.consumed} remaining=${liveUsage.account.remaining}; ` +
      `Premium consumed=${liveUsage.user.consumed} remaining=${liveUsage.user.remaining}`
  );
  log("Demo completed successfully. The API key was not printed.");

  return { newDecisions, replay, liveUsage };
}

async function main(): Promise<void> {
  await runDemoScenario(loadDemoClientConfig());
}

const invokedFile = process.argv[1];
if (
  invokedFile !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedFile)).href
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Demo client failed.");
    process.exitCode = 1;
  }
}
