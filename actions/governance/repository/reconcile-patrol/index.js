import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileRepositoryPatrolAction } from "../../../../packages/core/governance/patrol/action.js";

await runAction(reconcileRepositoryPatrolAction);
