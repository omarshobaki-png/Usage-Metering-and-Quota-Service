import type { PlanScope } from "../../shared/validation.js";

export interface PlanSummary {
  id: number;
  name: string;
  scope: PlanScope;
  monthlyLimit: number;
  maxUnitsPerRequest: number;
  revision: number;
}
