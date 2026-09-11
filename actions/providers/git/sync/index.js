import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { synchronizeGitAction } from "../../../../packages/core/providers/sync-git/action.mjs";

await runAction(synchronizeGitAction);
