import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealNativeResultAction } from "../../../../packages/core/build/signing/authority-actions.js";
await runAction(sealNativeResultAction);
