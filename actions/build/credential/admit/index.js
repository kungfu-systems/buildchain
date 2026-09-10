import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitBuildCredentialAction } from "../../../../packages/core/build/signing/actions.js";
await runAction(admitBuildCredentialAction);
