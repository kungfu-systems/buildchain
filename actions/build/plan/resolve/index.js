import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { resolveBuildPlanAction } from "../../../../packages/core/build/plan/action.js";
await runAction(resolveBuildPlanAction);
