import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizeBuildAction } from "../../../../packages/core/build/summary/action.js";
await runAction(finalizeBuildAction);
