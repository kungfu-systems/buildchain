import { requireValue } from "../../runtime/action-process.mjs";
import { completeUniversalWorkflow } from "../universal-workflow-bootstrap.js";

export function recoveryCoordinates(request) {
  const candidate = request.candidate;
  requireValue(
    request.schema === "kungfu-buildchain-v4-universal-workflow-request/v1" &&
      request.mode === "train",
    "Recovery requires the current Train request envelope",
  );
  requireValue(
    candidate?.repository === "kungfu-systems/buildchain" &&
      /^train\/v4\/v4\.\d+\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(
        candidate.discoveryRef || "",
      ) &&
      !candidate.discoveryRef.split("/").includes(".."),
    "Recovery requires a Buildchain capability Train",
  );
  requireValue(
    /^[0-9a-f]{40}$/u.test(candidate.expectedSha || "") &&
      Number.isSafeInteger(candidate.reviewPullRequest) &&
      candidate.reviewPullRequest > 0,
    "Recovery requires an exact candidate SHA and review PR",
  );
  return {
    repository: candidate.repository,
    ref: candidate.discoveryRef,
    sha: candidate.expectedSha,
    pr: candidate.reviewPullRequest,
  };
}
export function recoveryTerminalReceipt(admission, result) {
  requireValue(
    result.schema === "kungfu-buildchain-v4-universal-workflow-result/v1" &&
      ["succeeded", "failed"].includes(result.status) &&
      result.requestRoot === admission.requestRoot &&
      result.capabilityRoot === admission.capabilityRoot &&
      result.runtime?.repository === admission.runtime?.repository &&
      result.runtime?.sha === admission.runtime?.sha,
    "candidate result does not match the consumer-owned admission lineage",
  );
  return completeUniversalWorkflow({
    admission,
    resultRoot: result.resultRoot,
    status: result.status,
  });
}
