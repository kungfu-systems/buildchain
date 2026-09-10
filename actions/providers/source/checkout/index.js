import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { checkoutExactSourceAction } from "../../../../packages/core/providers/source-checkout/action.js";
await runAction(checkoutExactSourceAction);
