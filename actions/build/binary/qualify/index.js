import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyBinaryDistributionAction } from "../../../../packages/core/build/binary/actions.js";

await runAction(qualifyBinaryDistributionAction);
