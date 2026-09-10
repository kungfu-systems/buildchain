import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { routePromotionAction } from "../../../../packages/core/release/promotion/actions.js";
await runAction(routePromotionAction);
