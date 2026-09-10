import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webPublicationCapabilityAction } from "../../../../packages/core/web/publication-capability-action.js";

await runAction(webPublicationCapabilityAction);
