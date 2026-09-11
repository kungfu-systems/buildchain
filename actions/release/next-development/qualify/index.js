import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyNextDevelopmentAction } from "../../../../packages/core/release/next-development/actions.js";
await runAction(qualifyNextDevelopmentAction);
