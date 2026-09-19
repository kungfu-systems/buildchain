import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { wakePipelineAction } from "../../../../packages/core/workflow/pipeline/actions.js";
await runAction(wakePipelineAction);
