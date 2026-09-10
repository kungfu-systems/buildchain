import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { executeGateProfileAction } from "../../../../packages/core/build/gate/actions.js";
await runAction(executeGateProfileAction);
