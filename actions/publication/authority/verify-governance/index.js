import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifyPublicationGovernanceAction } from "../../../../packages/core/publication/authority/actions.js";
await runAction(verifyPublicationGovernanceAction);
