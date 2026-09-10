import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileMergeQueueAction } from "../../../../packages/core/dev-delivery/queue/reconciliation-action.js";
await runAction(reconcileMergeQueueAction);
