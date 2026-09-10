import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { lookupSourceProofAction } from "../../../../packages/core/build/source/proof-actions.js";

await runAction(lookupSourceProofAction);
