import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifySourceRuntimeAction } from "../../../../packages/core/build/source/checkout-action.js";
await runAction(verifySourceRuntimeAction);
