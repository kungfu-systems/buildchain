import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { completeNextDevelopmentReviewAction } from "../../../../packages/core/release/next-development/actions.js";
await runAction(completeNextDevelopmentReviewAction);
