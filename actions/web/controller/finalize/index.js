import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizeWebControllerAction } from "../../../../packages/core/web/controller-actions.js";

await runAction(finalizeWebControllerAction);
