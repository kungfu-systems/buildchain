import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyAdopterPlatformAction } from "../../../../packages/core/adoption/qualification/actions.js";

await runAction(qualifyAdopterPlatformAction);
