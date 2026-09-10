import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reviewUniversalCandidateAction } from "../../../../packages/core/workflow/admission/actions.js";

await runAction(reviewUniversalCandidateAction);
