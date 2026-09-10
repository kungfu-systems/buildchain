import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { reserveDeliveryCandidateAction } from "../../../../packages/core/dev-delivery/candidate/reservation-action.js";
await runAction(reserveDeliveryCandidateAction);
