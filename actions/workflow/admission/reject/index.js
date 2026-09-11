import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { rejectRequestAction } from "../../../../packages/core/workflow/request-rejection.js";

await runAction(rejectRequestAction);
