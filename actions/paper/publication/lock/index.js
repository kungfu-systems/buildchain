import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { lockPaperPublicationAction } from "../../../../packages/core/paper/publication/actions.js";
await runAction(lockPaperPublicationAction);
