import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { buildPipelineVersionAction } from "../../../../packages/core/publication/pipeline/version-actions.js";
await runAction(buildPipelineVersionAction);
