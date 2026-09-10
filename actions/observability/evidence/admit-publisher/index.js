import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { evidencePublisherAdmissionAction } from "../../../../packages/core/observability/publisher-admission.js";

await runAction(evidencePublisherAdmissionAction);
