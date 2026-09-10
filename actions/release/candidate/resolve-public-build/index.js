import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { resolvePublicQualificationAction } from "../../../../packages/core/release/qualification/actions.js";
await runAction(resolvePublicQualificationAction);
