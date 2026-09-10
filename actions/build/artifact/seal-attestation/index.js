import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealAttestationAction } from "../../../../packages/core/build/github-attestation/action.js";
await runAction(sealAttestationAction);
