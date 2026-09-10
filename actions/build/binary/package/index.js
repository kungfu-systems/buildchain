import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { buildBinaryDistributionAction } from "../../../../packages/core/build/binary/actions.js";

await runAction(buildBinaryDistributionAction);
