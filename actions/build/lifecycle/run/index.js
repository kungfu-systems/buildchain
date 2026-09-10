import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { runLifecycleAction } from "../../../../packages/core/build/lifecycle/action.js";
await runAction(runLifecycleAction);
