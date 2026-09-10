import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileSelfDogfoodAction } from "../../../../packages/core/workflow/dogfood/actions.js";

await runAction(reconcileSelfDogfoodAction);
