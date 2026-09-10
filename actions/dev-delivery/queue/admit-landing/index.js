import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { admitLandingAction } from "../../../../packages/core/dev-delivery/queue/landing-action.js";
await runAction(admitLandingAction);
