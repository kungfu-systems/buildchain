import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitAttestationAction } from "../../../../packages/core/build/github-attestation/action.js";
await runAction(admitAttestationAction);
