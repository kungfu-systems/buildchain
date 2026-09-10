import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { collectPublicationEvidenceAction } from "../../../../packages/core/publication/candidate/collection-action.js";
await runAction(collectPublicationEvidenceAction);
