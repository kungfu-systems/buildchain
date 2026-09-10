import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifyPublicationSettlementAction } from "../../../../packages/core/publication/settlement/actions.js";
await runAction(verifyPublicationSettlementAction);
