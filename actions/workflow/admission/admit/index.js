import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitUniversalCandidateAction } from "../../../../packages/core/workflow/admission/actions.js";

await runAction(admitUniversalCandidateAction);
