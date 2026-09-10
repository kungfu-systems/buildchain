import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { inspectPromotionInvocationAction } from "../../../../packages/core/release/promotion/actions.js";
await runAction(inspectPromotionInvocationAction);
