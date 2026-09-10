import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealNativeExecutionAction } from "../../../../packages/core/dev-delivery/native/seal-action.js";
await runAction(sealNativeExecutionAction);
