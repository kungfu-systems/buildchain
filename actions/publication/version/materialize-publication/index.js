import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { materializePipelinePublicationAction } from "../../../../packages/core/publication/pipeline/version-actions.js";
await runAction(materializePipelinePublicationAction);
