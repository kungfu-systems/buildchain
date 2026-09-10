import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { evaluateSourceProofAction } from "../../../../packages/core/build/source/proof-actions.js";

await runAction(evaluateSourceProofAction);
