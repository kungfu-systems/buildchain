import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { runBuildStageAction } from "../../../../packages/core/build/lifecycle/stage-action.js";
await runAction(runBuildStageAction);
