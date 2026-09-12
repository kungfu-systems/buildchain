import fs from "node:fs";
import path from "node:path";
import { deliveryActionContext } from "./action-context.js";
import { heartbeatDeliveryAttempt } from "./heartbeat.js";
import { guardPipelineDelivery } from "../../workflow/pipeline/guard.js";
export async function heartbeatDeliveryAttemptAction(core, env) {
  const { workspace, run } = deliveryActionContext(core, env);
  const admission = JSON.parse(
    fs.readFileSync(
      path.join(workspace, ".buildchain/dev-delivery/warrant.json"),
      "utf8",
    ),
  );
  const receipt = await heartbeatDeliveryAttempt({
    admission,
    workflowRunId: run.id,
    workflowRunAttempt: run.attempt,
    repository: env.GITHUB_REPOSITORY,
    branch: core.getInput("branch", { required: true }),
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    leaseSeconds: Number(core.getInput("lease-seconds")),
    heartbeatSeconds: Number(core.getInput("heartbeat-seconds")),
    beforeHeartbeat: () => {
      const warrant = admission.observation?.activeWarrant || admission.warrant;
      return guardPipelineDelivery(
        {
          "pipeline-attempt": core.getInput("pipeline-attempt"),
          "target-branch": core.getInput("branch", { required: true }),
          "expected-pr-number": warrant?.pullRequestNumber,
          "expected-head-sha": warrant?.sourceHead,
        },
        {
          repository: env.GITHUB_REPOSITORY,
          token: core.getInput("token", { required: true }),
        },
      );
    },
  });
  fs.writeFileSync(
    path.join(workspace, ".buildchain/provider-heartbeat-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  core.setOutput("receipt-root", receipt.receiptRoot);
}
