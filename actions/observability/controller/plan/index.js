import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { controllerPlanAction } from "../../../../packages/core/observability/controller-actions.js";

await runAction(controllerPlanAction);
