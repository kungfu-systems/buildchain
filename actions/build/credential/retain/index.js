import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { retainBuildCredentialAction } from "../../../../packages/core/build/signing/actions.js";
await runAction(retainBuildCredentialAction);
