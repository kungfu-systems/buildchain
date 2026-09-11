import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { heartbeatDeliveryAttemptAction } from "../../../../packages/core/dev-delivery/native/heartbeat-action.js";
await runAction(heartbeatDeliveryAttemptAction);
