import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { sourceAdmissionAction } from "../../../../packages/core/build/source-admission.js";

await runAction(sourceAdmissionAction);
