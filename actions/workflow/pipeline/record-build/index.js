import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { recordPipelineCheckAction } from "../../../../packages/core/workflow/pipeline/record-check.js";
await runAction(recordPipelineCheckAction);
