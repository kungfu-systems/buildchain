import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyRepositorySourceAction } from "../../../../packages/core/build/verification/actions.js";

await runAction(qualifyRepositorySourceAction);
