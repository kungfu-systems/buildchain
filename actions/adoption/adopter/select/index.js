import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { selectAdopterAction } from "../../../../packages/core/adoption/qualification/actions.js";

await runAction(selectAdopterAction);
