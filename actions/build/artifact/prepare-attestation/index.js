import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { prepareAttestationAction } from "../../../../packages/core/build/github-attestation/action.js";
await runAction(prepareAttestationAction);
