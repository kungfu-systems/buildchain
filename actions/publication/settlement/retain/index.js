import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { retainPublicationSettlementAction } from "../../../../packages/core/publication/settlement/actions.js";
await runAction(retainPublicationSettlementAction);
