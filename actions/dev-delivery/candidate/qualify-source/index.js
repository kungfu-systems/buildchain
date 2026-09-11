import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyDeliverySourceAction } from "../../../../packages/core/dev-delivery/candidate/admission-actions.js";
await runAction(qualifyDeliverySourceAction);
