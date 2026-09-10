import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizeResealPlatformAction } from "../../../../packages/core/release/reseal/actions.js";
await runAction(finalizeResealPlatformAction);
