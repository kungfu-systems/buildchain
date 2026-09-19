import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealPipelineQualificationAction } from "../../../../packages/core/publication/pipeline/actions.js";
await runAction(sealPipelineQualificationAction);
