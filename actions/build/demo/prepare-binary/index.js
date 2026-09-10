import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { prepareDemoBinaryAction } from "../../../../packages/core/build/demo/binary-action.js";
await runAction(prepareDemoBinaryAction);
