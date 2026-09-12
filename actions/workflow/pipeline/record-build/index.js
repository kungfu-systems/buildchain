import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { recordPipelineBuildAction } from "../../../../packages/core/workflow/pipeline/actions.js";
await runAction(recordPipelineBuildAction);
