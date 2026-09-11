import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { aggregateGateProfilesAction } from "../../../../packages/core/build/gate/actions.js";
await runAction(aggregateGateProfilesAction);
