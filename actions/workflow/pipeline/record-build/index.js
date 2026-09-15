import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { recordPipelineBuildAction } from "../../../../packages/core/workflow/pipeline/record-action.js";
await runAction(recordPipelineBuildAction);
