import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcilePropagationAction } from "../../../../packages/core/release/propagation/actions.js";

await runAction(reconcilePropagationAction);
