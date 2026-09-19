import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { recordDiscussionAction } from "../../../../packages/core/release/discussion/actions.js";
await runAction(recordDiscussionAction);
