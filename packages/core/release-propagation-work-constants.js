export const RELEASE_PROPAGATION_WORK_CONTRACT = "kungfu-buildchain-release-propagation-work";
export const RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT = "kungfu-buildchain-release-propagation-stage-receipt";

export const RELEASE_PROPAGATION_WORK_STAGES = Object.freeze([
  "materialize",
  "verify-release",
  "push-branch",
  "pull-request",
  "preview",
  "independent-review",
  "protected-merge",
  "staging",
  "production-release",
  "production-deploy",
  "online-readback",
  "complete",
]);

export const EXECUTION_ACTIONS = new Set(RELEASE_PROPAGATION_WORK_STAGES);
export const FAILURE_DISPOSITIONS = new Map([
  ["stale-branch", "retry"],
  ["expected-old-mismatch", "retry"],
  ["lockfile-drift", "retry"],
  ["failed-check", "retry"],
  ["interrupted-execution", "retry"],
  ["ci-delay", "retry"],
  ["semantic-ambiguity", "needs-decision"],
  ["credential", "needs-decision"],
  ["policy-expansion", "needs-decision"],
  ["unknown", "needs-decision"],
  ["release-contract-mismatch", "hard-safety-gate"],
  ["immutable-artifact-conflict", "hard-safety-gate"],
  ["destructive-required", "hard-safety-gate"],
]);
