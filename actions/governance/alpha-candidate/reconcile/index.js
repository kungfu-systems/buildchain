import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileAlphaCandidateAction } from "../../../../packages/core/governance/alpha-candidate/action.js";
await runAction(reconcileAlphaCandidateAction);
