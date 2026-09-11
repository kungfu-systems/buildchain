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
    validFrom: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}
export function request(policyValue = policy(), overrides = {}) {
  return {
    schema: UNIVERSAL_WORKFLOW_REQUEST,
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
export const runtime = () => ({ repository: "kungfu-systems/buildchain", sha: sha("1") });
export const consumerObservation = () => ({
  runtime: runtime(),
  observedConsumerRepository: "kungfu-systems/taolu",
  observedConsumerSha: sha("2"),
  observedConsumerWorkflowRef:
    "kungfu-systems/taolu/.github/workflows/release.yml@refs/heads/main",
});
