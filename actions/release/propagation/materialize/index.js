import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { materializePropagationAction } from "../../../../packages/core/release/propagation/actions.js";

await runAction(materializePropagationAction);
