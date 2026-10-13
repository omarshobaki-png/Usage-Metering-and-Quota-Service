import { z } from "zod";

export const positiveUnitsSchema = z.number().int().positive();
