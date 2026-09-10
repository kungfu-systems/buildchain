import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { qualifyPublicationAuthorityAction } from "../../../../packages/core/publication/authority/actions.js";
await runAction(qualifyPublicationAuthorityAction);
