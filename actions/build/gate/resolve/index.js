import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { planGateProfilesAction } from "../../../../packages/core/build/gate/actions.js";
await runAction(planGateProfilesAction);
