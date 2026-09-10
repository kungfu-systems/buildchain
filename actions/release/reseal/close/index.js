import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealTailResealAction } from "../../../../packages/core/release/reseal/actions.js";
await runAction(sealTailResealAction);
