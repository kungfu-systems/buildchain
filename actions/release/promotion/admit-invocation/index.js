import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitPromotionInvocationAction } from "../../../../packages/core/release/promotion/actions.js";
await runAction(admitPromotionInvocationAction);
