import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitCheckedConsumerPolicyAction } from "../../../../packages/core/consumer/policy-admission.js";
await runAction(admitCheckedConsumerPolicyAction);
