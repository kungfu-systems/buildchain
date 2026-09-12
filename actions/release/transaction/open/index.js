import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { openDiscussionAction } from "../../../../packages/core/release/discussion/actions.js";
await runAction(openDiscussionAction);
