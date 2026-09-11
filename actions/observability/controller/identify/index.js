import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { identifyControllerCheckoutsAction } from "../../../../packages/core/observability/controller/identity-action.js";
await runAction(identifyControllerCheckoutsAction);
