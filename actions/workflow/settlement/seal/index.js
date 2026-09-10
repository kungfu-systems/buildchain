import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealUniversalReceiptAction } from "../../../../packages/core/workflow/settlement/actions.js";

await runAction(sealUniversalReceiptAction);
