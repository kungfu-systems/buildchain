import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitDeliveryRequestAction } from "../../../../packages/core/dev-delivery/candidate/admission-actions.js";
await runAction(admitDeliveryRequestAction);
