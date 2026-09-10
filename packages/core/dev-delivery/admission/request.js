import path from "node:path";
export function admissionPolicyRequest(
  input,
  { repository, branch, workspace },
) {
  const required = input["delivery-warrant-mode"] === "required";
  return {
    repository,
    targetBranch: branch,
    targetPullRequestNumber: input["expected-pr-number"],
    expectedHeadSha: input["expected-head-sha"],
    readyLabel: input["ready-label"],
    blockLabels: input["block-labels"],
    allowedHeadPrefixes: input["allowed-head-prefixes"],
    requiredChecks: input["required-status-checks"],
    queueAdmissionContext:
      input["queue-admission-context"] ||
      (required ? "Queue admission lease" : ""),
    activeLeaseContext: input["active-lease-context"],
    diagnosticContext: input["diagnostic-context"],
    requireApproval: input["require-approval"],
    sameRepositoryOnly: input["same-repository-only"],
    maxMerges: input["max-merges"],
    mergeMethod: input["merge-method"],
    landingMode: input["landing-mode"],
    warrantMode: required ? "required" : "off",
    sourcePatchRoot: input["source-patch-root"],
    dryRun: input["dry-run"],
    sourceProofPath: path.join(
      workspace,
      ".buildchain/dev-delivery/source-proof.json",
    ),
  };
}
