import type { Pool } from "pg";

import {
  provisionAccount,
  type ProvisionedAccount
} from "../../src/modules/accounts/provision-account.js";
import {
  createCustomPlan,
  type Plan
} from "../../src/modules/plans/service.js";
import { createUser, type User } from "../../src/modules/users/service.js";

export interface TwoAccountFixture {
  accountA: ProvisionedAccount;
  accountB: ProvisionedAccount;
  userA: User;
  userB: User;
  customPlanA: Plan;
  customPlanB: Plan;
}

export async function createTwoAccountFixture(
  pool: Pool,
  apiKeyPepper: string
): Promise<TwoAccountFixture> {
  const accountA = await provisionAccount(pool, {
    name: "Account A",
    apiKeyPepper
  });
  const accountB = await provisionAccount(pool, {
    name: "Account B",
    planName: "Pro",
    apiKeyPepper
  });
  const userA = await createUser(pool, accountA.id);
  const userB = await createUser(pool, accountB.id);
  const customPlanA = await createCustomPlan(pool, accountA.id, {
    name: "Account A Custom User",
    scope: "user",
    monthlyLimit: 50,
    requestLimit: 5
  });
  const customPlanB = await createCustomPlan(pool, accountB.id, {
    name: "Account B Custom User",
    scope: "user",
    monthlyLimit: 75,
    requestLimit: 5
  });

  return {
    accountA,
    accountB,
    userA,
    userB,
    customPlanA,
    customPlanB
  };
}
