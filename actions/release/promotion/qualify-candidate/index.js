import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyPromotionAction } from "../../../../packages/core/release/promotion/qualification-action.js";
await runAction(qualifyPromotionAction);
