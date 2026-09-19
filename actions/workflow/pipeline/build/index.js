import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { buildPipelineAction } from "../../../../packages/core/workflow/pipeline/actions.js";
await runAction(buildPipelineAction);
