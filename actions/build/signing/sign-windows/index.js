import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { signWindowsRequestAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(signWindowsRequestAction);
