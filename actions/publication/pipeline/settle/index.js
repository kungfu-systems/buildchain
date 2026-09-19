import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { settlePipelinePublicationAction } from "../../../../packages/core/publication/pipeline/actions.js";
await runAction(settlePipelinePublicationAction);
