import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { controlPipelineNativeAction } from "../../../../packages/core/publication/pipeline/native-actions.js";
await runAction(controlPipelineNativeAction);
