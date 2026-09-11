import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { lineBootstrapAction } from "../../../../packages/core/release/line/action.js";
await runAction(lineBootstrapAction);
