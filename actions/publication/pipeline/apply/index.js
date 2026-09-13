import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { applyPipelinePublicationAction } from "../../../../packages/core/publication/pipeline/actions.js";
await runAction(applyPipelinePublicationAction);
