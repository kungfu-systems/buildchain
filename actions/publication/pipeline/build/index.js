import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { buildPipelinePublicationAction } from "../../../../packages/core/publication/pipeline/actions.js";
await runAction(buildPipelinePublicationAction);
