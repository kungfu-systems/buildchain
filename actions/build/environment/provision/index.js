import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { provisionBuildEnvironmentAction } from "../../../../packages/core/build/environment/action.js";
await runAction(provisionBuildEnvironmentAction);
