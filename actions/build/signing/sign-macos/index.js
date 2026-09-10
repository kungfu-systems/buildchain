import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { signMacosRequestAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(signMacosRequestAction);
