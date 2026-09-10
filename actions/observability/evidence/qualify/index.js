import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyObservedEvidenceAction } from "../../../../packages/core/observability/evidence/actions.js";

await runAction(qualifyObservedEvidenceAction);
