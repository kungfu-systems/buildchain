import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitPaperCandidateAction } from "../../../../packages/core/paper/publication/actions.js";
await runAction(admitPaperCandidateAction);
