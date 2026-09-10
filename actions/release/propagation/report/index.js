import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reportPropagationAction } from "../../../../packages/core/release/propagation/actions.js";

await runAction(reportPropagationAction);
