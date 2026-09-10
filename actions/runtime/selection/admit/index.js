import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { runtimeSelectionAction } from "../../../../packages/core/runtime/runtime-selection-action.js";

await runAction(runtimeSelectionAction);
