import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitSelfDogfoodAction } from "../../../../packages/core/workflow/dogfood/actions.js";

await runAction(admitSelfDogfoodAction);
