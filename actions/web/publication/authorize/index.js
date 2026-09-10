import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webProductionDecisionAction } from "../../../../packages/core/web/production-decision-action.js";

await runAction(webProductionDecisionAction);
