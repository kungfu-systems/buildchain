import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webDeploymentAction } from "../../../../packages/core/web/deployment/apply-action.js";

await runAction(webDeploymentAction);
