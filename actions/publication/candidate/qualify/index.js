import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyPublicationCandidateAction } from "../../../../packages/core/publication/candidate/qualification-action.js";
await runAction(qualifyPublicationCandidateAction);
