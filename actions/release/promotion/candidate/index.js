import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { candidatePublicationAction } from "../../../../packages/core/release/promote-candidate/action.js";

await runAction(candidatePublicationAction);
