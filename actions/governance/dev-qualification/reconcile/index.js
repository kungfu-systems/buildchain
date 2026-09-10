import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileDevQualificationAction } from "../../../../packages/core/dev-delivery/qualification/action.js";

await runAction(reconcileDevQualificationAction);
