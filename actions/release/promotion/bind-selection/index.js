import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { bindPromotionSelectionAction } from "../../../../packages/core/release/promotion/actions.js";
await runAction(bindPromotionSelectionAction);
