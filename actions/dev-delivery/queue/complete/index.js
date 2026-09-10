import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { completeDeliveryAction } from "../../../../packages/core/dev-delivery/queue/landing-action.js";
await runAction(completeDeliveryAction);
