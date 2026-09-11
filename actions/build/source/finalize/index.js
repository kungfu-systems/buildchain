import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { finalizeSourceQualificationAction } from "../../../../packages/core/build/source/controller-actions.js";

await runAction(finalizeSourceQualificationAction);
