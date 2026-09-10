import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { settleNativeFailureAction } from "../../../../packages/core/dev-delivery/warrant/actions.js";
await runAction(settleNativeFailureAction);
