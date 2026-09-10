import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitWorkflowEventAction } from "../../../../packages/core/workflow/event-trust.js";
await runAction(admitWorkflowEventAction);
