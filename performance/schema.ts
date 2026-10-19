import { z } from "zod";

import { loadResultSchema } from "./report.js";

// Print only JSON so the checked-in schema can be compared with its source.
console.log(JSON.stringify({ ...z.toJSONSchema(loadResultSchema), $id: "urn:usage-metering:load-result:v1" }, null, 2));
