import type { Pool } from "pg";

import type { PlanScope } from "../../db/seed.js";

export interface PlanCatalogItem {
  id: number;
  scope: PlanScope;
  name: string;
  monthlyLimit: number;
  maxUnitsPerRequest: number;
}

export async function listPredefinedPlans(
  pool: Pool,
  scope: PlanScope
): Promise<PlanCatalogItem[]> {
  const result = await pool.query<PlanCatalogItem>(
    `
      SELECT
        id,
        scope,
        name,
        monthly_limit AS "monthlyLimit",
        max_units_per_request AS "maxUnitsPerRequest"
      FROM plans
      WHERE owner_account_id IS NULL AND scope = $1
      ORDER BY name
    `,
    [scope]
  );

  return result.rows;
}
