import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { executeDeliveryNativeAction } from "../../../../packages/core/dev-delivery/native/actions.js";
await runAction(executeDeliveryNativeAction);
