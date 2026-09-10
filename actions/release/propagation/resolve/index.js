import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { resolvePropagationAction } from "../../../../packages/core/release/propagation/actions.js";

await runAction(resolvePropagationAction);
