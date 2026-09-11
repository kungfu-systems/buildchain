import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitBinaryDistributionAction } from "../../../../packages/core/build/binary/actions.js";

await runAction(admitBinaryDistributionAction);
