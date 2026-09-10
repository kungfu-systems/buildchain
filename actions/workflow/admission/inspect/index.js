import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { inspectUniversalRequestAction } from "../../../../packages/core/workflow/admission/actions.js";

await runAction(inspectUniversalRequestAction);
