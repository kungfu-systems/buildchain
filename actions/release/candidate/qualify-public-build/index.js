import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyPublicCandidateAction } from "../../../../packages/core/release/qualification/actions.js";
await runAction(qualifyPublicCandidateAction);
