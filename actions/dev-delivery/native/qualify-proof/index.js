import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyTransferredNativeAction } from "../../../../packages/core/dev-delivery/native/actions.js";
await runAction(qualifyTransferredNativeAction);
