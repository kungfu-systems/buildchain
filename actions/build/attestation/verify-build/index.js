import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifyBuildAttestationAction } from "../../../../packages/core/build/artifact/actions.js";
await runAction(verifyBuildAttestationAction);
