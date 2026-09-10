import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileAdopterReportsAction } from "../../../../packages/core/adoption/qualification/actions.js";

await runAction(reconcileAdopterReportsAction);
