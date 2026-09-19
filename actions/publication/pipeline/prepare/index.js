import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { preparePipelinePublicationAction } from "../../../../packages/core/publication/pipeline/actions.js";
await runAction(preparePipelinePublicationAction);
