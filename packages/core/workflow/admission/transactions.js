import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import {
  validateUniversalWorkflowRequest,
  universalWorkflowRequestRoot,
  admitUniversalWorkflow,
} from "../universal-workflow-bootstrap.js";
import { recoveryCoordinates } from "./recovery.js";
export function inspectUniversalRequest(request, recovery = false) {
  if (recovery) recoveryCoordinates(request);
  const value = validateUniversalWorkflowRequest(request);
  return {
    mode: value.mode,
    repository: value.candidate.repository,
    "discovery-ref": value.candidate.discoveryRef,
    "expected-sha": value.candidate.expectedSha,
    "review-pr": value.candidate.reviewPullRequest,
    "capability-id": value.capability.id,
    "request-root": universalWorkflowRequestRoot(value),
  };
}
export function admitReviewedWorkflow({
  request,
  reviewEvidence,
  workspace,
  candidateRoot,
  consumer,
}) {
  const observedSha = command(
    "git",
    ["-C", candidateRoot, "rev-parse", "HEAD"],
    { stdio: "pipe" },
  )
    .trim()
    .toLowerCase();
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(
        candidateRoot,
        "architecture/universal-workflow-train-admission.json",
      ),
      "utf8",
    ),
  );
  const admitted = admitUniversalWorkflow({
    request,
    policy,
    observedRefSha: observedSha,
    observedConsumerRepository: consumer.repository,
    observedConsumerSha: consumer.sha,
    observedConsumerWorkflowRef: consumer.workflowRef,
    reviewEvidence,
    now: new Date().toISOString(),
  });
  const file = path.join(workspace, ".buildchain/admission.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(admitted, null, 2) + "\n");
  return admitted;
}
