import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitSigningRequestsAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(admitSigningRequestsAction);
