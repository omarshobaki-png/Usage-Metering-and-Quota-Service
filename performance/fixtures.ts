import type { Pool } from "pg";

import { DemoApiClient } from "../demo/client.js";
import { provisionAccount } from "../src/modules/accounts/provision-account.js";
import type { LoadOptions } from "./config.js";

export interface LoadAccount {
  id: string;
  apiKey: string;
  accountPlanId: number;
  userPlanId: number;
  monthlyLimit: number;
  userMonthlyLimit: number;
  requestLimit: number;
  userIds: string[];
}

export async function createLoadFixtures(
  pool: Pool, options: LoadOptions, pepper: string, runId: string
): Promise<LoadAccount[]> {
  const fixtures: LoadAccount[] = [];
  for (let index = 0; index < options.accounts; index += 1) {
    const account = await provisionAccount(pool, {
      name: `Load ${runId} account ${index + 1}`, apiKeyPepper: pepper
    });
    const api = new DemoApiClient({ serviceUrl: options.baseUrl, apiKey: account.apiKey });
    const monthlyLimit = options.workload === "correctness" ? 100 : (options.monthlyLimit ?? options.requests);
    const userMonthlyLimit = options.monthlyLimit ?? options.requests;
    const requestLimit = options.requests;
    const accountPlan = await api.createPlan({
      name: "Load Account", scope: "account", monthlyLimit, requestLimit
    });
    const userPlan = await api.createPlan({
      name: "Load User", scope: "user", monthlyLimit: userMonthlyLimit, requestLimit
    });
    await api.assignAccountPlan(accountPlan.id);
    const userIds: string[] = [];
    for (let user = 0; user < options.usersPerAccount; user += 1) {
      userIds.push((await api.createUser(userPlan.id)).id);
    }
    fixtures.push({
      id: account.id, apiKey: account.apiKey, accountPlanId: accountPlan.id,
      userPlanId: userPlan.id, monthlyLimit, userMonthlyLimit, requestLimit, userIds
    });
  }
  return fixtures;
}
