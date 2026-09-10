import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitAdopterPolicyAction } from "../../../../packages/core/adoption/qualification/actions.js";

await runAction(admitAdopterPolicyAction);
