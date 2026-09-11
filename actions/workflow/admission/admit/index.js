import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitConsumerCapabilityAction } from "../../../../packages/core/workflow/admission/actions.js";

await runAction(admitConsumerCapabilityAction);
