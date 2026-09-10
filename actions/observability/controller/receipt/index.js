import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { controllerReceiptAction } from "../../../../packages/core/observability/controller-actions.js";

await runAction(controllerReceiptAction);
