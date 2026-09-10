import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webReleaseReviewAction } from "../../../../packages/core/web/release-review-action.js";

await runAction(webReleaseReviewAction);
