import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileHousekeepingAction } from "../../../../packages/core/governance/housekeeping/action.js";

await runAction(reconcileHousekeepingAction);
