import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webApplyAdmissionAction } from "../../../../packages/core/web/apply-admission-action.js";

await runAction(webApplyAdmissionAction);
