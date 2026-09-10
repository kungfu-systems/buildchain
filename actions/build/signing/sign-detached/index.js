import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { signDetachedRequestsAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(signDetachedRequestsAction);
