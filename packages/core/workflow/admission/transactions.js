import fs from "node:fs";
import path from "node:path";
import {
  validateUniversalWorkflowRequest,
  universalWorkflowRequestRoot,
  admitUniversalWorkflow,
} from "../universal-workflow-bootstrap.js";
export function inspectUniversalRequest(request) {
  const value = validateUniversalWorkflowRequest(request);
  return {
    "capability-id": value.capability.id,
    "request-root": universalWorkflowRequestRoot(value),
  };
}
export function admitConsumerCapability({
  request,
  workspace,
  runtimeRoot,
  consumer,
  runtime,
}) {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeRoot,
        "architecture/universal-workflow-capability-policy.json",
      ),
      "utf8",
    ),
  );
  const admitted = admitUniversalWorkflow({
    request,
    policy,
    runtime,
    observedConsumerRepository: consumer.repository,
    observedConsumerSha: consumer.sha,
    observedConsumerWorkflowRef: consumer.workflowRef,
      now: new Date().toISOString(),
  });
  const file = path.join(workspace, ".buildchain/admission.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(admitted, null, 2) + "\n");
  return admitted;
}
