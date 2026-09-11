import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { completeBuildSigningAction } from "../../../../packages/core/build/signing/actions.js";
await runAction(completeBuildSigningAction);
