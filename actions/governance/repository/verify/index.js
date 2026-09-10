import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitGithubGovernanceAction } from "../../../../packages/core/governance/receipt-admission-action.js";

await runAction(admitGithubGovernanceAction);
