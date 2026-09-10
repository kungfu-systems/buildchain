import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { generateSelfDogfoodRequestsAction } from "../../../../packages/core/workflow/dogfood/actions.js";

await runAction(generateSelfDogfoodRequestsAction);
