import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sealWebPublicationAction } from "../../../../packages/core/web/publication-admission-action.js";

await runAction(sealWebPublicationAction);
