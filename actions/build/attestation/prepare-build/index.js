import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { prepareBuildAttestationAction } from "../../../../packages/core/build/artifact/actions.js";
await runAction(prepareBuildAttestationAction);
