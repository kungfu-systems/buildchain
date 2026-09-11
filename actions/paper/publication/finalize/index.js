import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizePaperPublicationAction } from "../../../../packages/core/paper/publication/actions.js";
await runAction(finalizePaperPublicationAction);
