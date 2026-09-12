import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { inspectDiscussionAction } from "../../../../packages/core/release/discussion/actions.js";
await runAction(inspectDiscussionAction);
