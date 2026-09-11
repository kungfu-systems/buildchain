import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifySourceCheckoutAction } from "../../../../packages/core/build/source/checkout-action.js";
await runAction(verifySourceCheckoutAction);
