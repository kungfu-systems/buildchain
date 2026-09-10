import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { observePaperPublicationAction } from "../../../../packages/core/paper/publication/actions.js";
await runAction(observePaperPublicationAction);
