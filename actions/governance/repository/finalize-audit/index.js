import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizeGovernanceEvidenceAction } from "../../../../packages/core/governance/audit/actions.js";

await runAction(finalizeGovernanceEvidenceAction);
