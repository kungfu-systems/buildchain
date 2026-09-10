import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { publishObservedEvidenceAction } from "../../../../packages/core/observability/evidence/actions.js";

await runAction(publishObservedEvidenceAction);
