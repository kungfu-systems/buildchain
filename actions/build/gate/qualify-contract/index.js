import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyHistoricalBuildAction } from "../../../../packages/core/build/summary/compatibility.js";

await runAction(qualifyHistoricalBuildAction);
