import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { recoverPipelineAction } from "../../../../packages/core/workflow/pipeline/recovery-action.js";
await runAction(recoverPipelineAction);
