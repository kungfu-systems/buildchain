import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { initializeSourceQualificationAction } from "../../../../packages/core/build/source/controller-actions.js";

await runAction(initializeSourceQualificationAction);
