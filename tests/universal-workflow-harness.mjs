import { UNIVERSAL_WORKFLOW_ADMISSION_POLICY, UNIVERSAL_WORKFLOW_REQUEST, universalWorkflowAdmissionRoot } from "../packages/core/workflow/universal-workflow-bootstrap.js";
export const sha = (character) => character.repeat(40);
export const root = (character) => `sha256:${character.repeat(64)}`;
export function policy(overrides = {}) {
  return {
    schema: UNIVERSAL_WORKFLOW_ADMISSION_POLICY,
    sourceRepository: "kungfu-systems/buildchain",
    consumerAdmission: "verified-caller",
    allowedCapabilities: ["consumer-release"],
    permissionCeiling: {
      contents: "write",
      "id-token": "write",
      packages: "write",
    },
    contractRoots: [root("a"), root("b")],
    targetRef: "dev/v4/v4.0",
    allowedReviewers: ["kungfu-origin"],
    minimumApprovals: 1,
    requiredChecks: ["Verify"],
    validFrom: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}
export function request(policyValue = policy(), overrides = {}) {
  return {
    schema: UNIVERSAL_WORKFLOW_REQUEST,
    mode: "train",
    candidate: {
      repository: "kungfu-systems/buildchain",
      discoveryRef: "train/v4/v4.0/universal-reusable-workflow-bootstrap",
      expectedSha: sha("1"),
      admissionRoot: universalWorkflowAdmissionRoot(policyValue),
      reviewPullRequest: 42,
    },
    consumer: {
      repository: "kungfu-systems/taolu",
      workflow: ".github/workflows/release.yml",
      sourceSha: sha("2"),
    },
    capability: {
      id: "consumer-release",
      contractRoots: [root("a"), root("b")],
      permissions: {
        contents: "write",
        "id-token": "write",
        packages: "read",
      },
    },
    payload: { channel: "alpha", dryRun: false },
    ...overrides,
  };
}
export function reviewEvidence(overrides = {}) {
  return {
    repository: "kungfu-systems/buildchain",
    pullRequest: 42,
    headSha: sha("1"),
    baseRef: "dev/v4/v4.0",
    approvals: [
      {
        reviewer: "kungfu-origin",
        commitSha: sha("1"),
        submittedAt: "2026-08-30T11:00:00.000Z",
      },
    ],
    checks: [{ name: "Verify", status: "completed", conclusion: "success" }],
    observedAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}
export const consumerObservation = () => ({
  observedConsumerRepository: "kungfu-systems/taolu",
  observedConsumerSha: sha("2"),
  observedConsumerWorkflowRef:
    "kungfu-systems/taolu/.github/workflows/release.yml@refs/heads/main",
});
