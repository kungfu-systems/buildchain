import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { historicalEvidenceAction } from "../../../../packages/core/release/promotion/historical-evidence-action.js";
await runAction(historicalEvidenceAction);
