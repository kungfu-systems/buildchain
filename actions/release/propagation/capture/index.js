import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { capturePropagationAction } from "../../../../packages/core/release/propagation/actions.js";

await runAction(capturePropagationAction);
