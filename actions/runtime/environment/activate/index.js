import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { activateExecutionRuntimeAction } from "../../../../packages/core/runtime/entry/activation.js";

await runAction(activateExecutionRuntimeAction);
