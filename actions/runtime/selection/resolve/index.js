import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { selectExecutionRuntimeAction } from "../../../../packages/core/runtime/entry/actions.js";

await runAction(selectExecutionRuntimeAction);
