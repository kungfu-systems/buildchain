import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifySigningDeliveryAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(qualifySigningDeliveryAction);
