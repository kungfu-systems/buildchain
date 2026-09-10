import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyBuildBackboneAction } from "../../../../packages/core/build/verification/actions.js";

await runAction(qualifyBuildBackboneAction);
