import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifySourceLifecycleAction } from "../../../../packages/core/build/source/lifecycle-action.js";

await runAction(qualifySourceLifecycleAction);
