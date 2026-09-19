import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { materializePipelineDevelopmentAction } from "../../../../packages/core/publication/pipeline/version-actions.js";
await runAction(materializePipelineDevelopmentAction);
