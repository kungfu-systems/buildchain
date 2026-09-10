import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webDeploymentPlanAction } from "../../../../packages/core/web/deployment/planning-action.js";

await runAction(webDeploymentPlanAction);
