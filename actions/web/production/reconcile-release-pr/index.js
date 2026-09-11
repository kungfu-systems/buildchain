import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reconcileWebReleasePrAction } from "../../../../packages/core/web/release-pr-action.js";

await runAction(reconcileWebReleasePrAction);
