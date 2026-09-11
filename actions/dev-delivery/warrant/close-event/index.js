import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { settleTerminalDeliveryAction } from "../../../../packages/core/dev-delivery/warrant/actions.js";
await runAction(settleTerminalDeliveryAction);
