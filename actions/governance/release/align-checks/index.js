import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileReleaseGovernanceAction } from "../../../../packages/core/governance/release-reconciliation-action.js";

await runAction(reconcileReleaseGovernanceAction);
