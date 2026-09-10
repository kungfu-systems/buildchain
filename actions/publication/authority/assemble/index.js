import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { assemblePublicationAdmissionAction } from "../../../../packages/core/publication/authority/actions.js";
await runAction(assemblePublicationAdmissionAction);
