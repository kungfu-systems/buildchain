import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { verifyReleaseLineageAction } from "../../../../packages/core/release/line/verification-action.js";
await runAction(verifyReleaseLineageAction);
