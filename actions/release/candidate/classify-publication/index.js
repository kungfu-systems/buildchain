import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { classifyPublicationHeadAction } from "../../../../packages/core/release/promotion/actions.js";
await runAction(classifyPublicationHeadAction);
