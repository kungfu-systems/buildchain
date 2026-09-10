import { runAction } from "../../../../packages/core/runtime/action-host.js";
import { webDeploymentReportAction } from "../../../../packages/core/web/deployment/report-action.js";

await runAction(webDeploymentReportAction);
