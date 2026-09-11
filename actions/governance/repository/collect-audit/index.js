import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { collectGovernanceEvidenceAction } from "../../../../packages/core/governance/audit/actions.js";

await runAction(collectGovernanceEvidenceAction);
