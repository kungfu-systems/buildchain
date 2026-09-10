import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { initializeWebControllerAction } from "../../../../packages/core/web/controller-actions.js";

await runAction(initializeWebControllerAction);
