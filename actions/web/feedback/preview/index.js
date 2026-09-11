import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { previewFeedbackAction } from "../../../../packages/core/web/preview-feedback-action.js";

await runAction(previewFeedbackAction);
