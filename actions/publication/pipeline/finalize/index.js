import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizePipelineNativeAction } from "../../../../packages/core/publication/pipeline/native-actions.js";
await runAction(finalizePipelineNativeAction);
