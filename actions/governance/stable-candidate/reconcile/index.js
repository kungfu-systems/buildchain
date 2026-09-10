import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileStableCandidateAction } from "../../../../packages/core/release/stable-patrol/action.js";

await runAction(reconcileStableCandidateAction);
