import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitTailResealPlanAction } from "../../../../packages/core/release/reseal/actions.js";
await runAction(admitTailResealPlanAction);
