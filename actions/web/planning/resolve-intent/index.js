import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { productionIntentAction } from "../../../../packages/core/web/production-intent-action.js";

await runAction(productionIntentAction);
