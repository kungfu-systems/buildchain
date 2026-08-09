import { V4ContractFault, v4ContentRoot } from "./v4-canonical-contracts.js";
import { emitV4PlatformStageCheckpoint } from "./v4-platform-stage-checkpoints.js";
import { V4_STAGE_CAPSULE_QUALIFICATION_FAULTS } from "./v4-stage-capsule-qualification.js";
import { planV4StageCapsuleResume } from "./v4-stage-capsule-resume-planner.js";
import { v4StageCapsuleBlobRoot } from "./v4-stage-capsule-store.js";

export const V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT = "2026-08-08T00:00:00.000Z";
export const V4_STAGE_CAPSULE_CAMPAIGN_STAGES = Object.freeze([
  "install",
  "build",
  "verify",
  "package",
]);
export const V4_STAGE_CAPSULE_CAMPAIGN_DEPENDENCIES = Object.freeze({
  install: [],
  build: ["install"],
  verify: ["build"],
  package: ["build", "verify"],
});

const ZERO_ROOT = `sha256:${"0".repeat(64)}`;
const RETAIN_UNTIL = "2026-09-08T00:00:00.000Z";

function rootOf(label) {
  return v4StageCapsuleBlobRoot(Buffer.from(`${label}\n`, "utf8"));
}

function outputBytes(context, stageId, outputName) {
  return Buffer.from(
    `${context.consumer}:${context.consumerSourceRevision}:${context.platform}:${stageId}:${outputName}:qualified-bytes\n`,
    "utf8",
  );
}

function inputRoot(context, name) {
  const producer = {
    "dependency-layout": ["install", "dependency-layout"],
    "build-output": ["build", "build-output"],
    "verification-report": ["verify", "verification-report"],
    "package-archive": ["package", "package-archive"],
  }[name];
  if (producer)
    return v4StageCapsuleBlobRoot(outputBytes(context, ...producer));
  return rootOf(
    `${context.consumer}:${context.consumerSourceRevision}:${context.platform}:input:${name}`,
  );
}

export function createV4StageCapsuleCampaignCheckpointRequest(
  context,
  stageId,
  store,
  stageOutcome = "success",
) {
  const stage = context.declaration.stages.find(({ id }) => id === stageId);
  if (!stage) throw new Error(`undeclared campaign stage: ${stageId}`);
  const outputs = Object.fromEntries(
    stage.outputs.map(({ name }) => [
      name,
      outputBytes(context, stageId, name),
    ]),
  );
  return {
    declaration: context.declaration,
    platformId: context.platform,
    stageId,
    stageOutcome,
    recordedAt: V4_STAGE_CAPSULE_CAMPAIGN_RECORDED_AT,
    overheadMs: 0,
    inputs: Object.fromEntries(
      stage.inputs.map((name) => [name, inputRoot(context, name)]),
    ),
    outputs,
    productionOutputRoots: Object.fromEntries(
      Object.entries(outputs).map(([name, bytes]) => [
        name,
        v4StageCapsuleBlobRoot(bytes),
      ]),
    ),
    productionLifecycleResult: { outcome: stageOutcome, stage: stageId },
    shadowLifecycleResult: { outcome: stageOutcome, stage: stageId },
    environment: Object.fromEntries(
      stage.environment.map((name) => [name, `${context.consumer}-${name}`]),
    ),
    toolchains: Object.fromEntries(
      stage.toolchains.map((name) => [
        name,
        rootOf(`${context.platform}:toolchain:${name}:node-24`),
      ]),
    ),
    runtime: {
      engine: "node",
      runtimeRef: context.runtimeRef,
      consumer: context.consumer,
    },
    transformation: {
      interface: "consumer-equivalent",
      providerEffects: false,
      stage: stageId,
    },
    qualification: {
      exactBytes: true,
      consumer: context.consumer,
      productionBytesChanged: false,
    },
    retentionPromise: {
      class: "wave-evidence",
      retainUntil: RETAIN_UNTIL,
    },
    store,
  };
}

export function emitV4StageCapsuleCampaignCheckpoint(
  context,
  stageId,
  store,
  stageOutcome = "success",
) {
  return emitV4PlatformStageCheckpoint(
    createV4StageCapsuleCampaignCheckpointRequest(
      context,
      stageId,
      store,
      stageOutcome,
    ),
  );
}

export function v4StageCapsuleCampaignAggregateRoots(entries) {
  const manifests = entries.map(({ stage, manifest }) => ({
    stage,
    manifestRoot: manifest.manifestRoot,
  }));
  const content = entries.flatMap(({ stage, manifest }) =>
    manifest.entries.map(({ name, root, size }) => ({
      stage,
      name,
      root,
      size,
    })),
  );
  return {
    artifactManifestRoot: v4ContentRoot(
      "stage-capsule-artifact-manifest",
      manifests,
    ),
    contentRoot: v4ContentRoot("stage-capsule-artifact-content", content),
  };
}

function unavailable(availability, status, faultCode) {
  availability.status = status;
  availability.contentRoot = null;
  availability.qualificationRoot = null;
  availability.faultCode = faultCode;
}

function faultDefinitions() {
  return {
    corrupt: [
      "reject",
      "corrupt",
      (value) =>
        unavailable(
          value.nodes[0].candidate.availability,
          "corrupt",
          "capsule-corrupt",
        ),
    ],
    "cross-platform": [
      "reject",
      "cross-platform",
      (value) => (value.nodes[0].expectedIdentity.platform = "other-platform"),
    ],
    "cross-stage": [
      "reject",
      "stage-mismatch",
      (value) => (value.nodes[0].expectedIdentity.stage = "other-stage"),
    ],
    expired: [
      "rebuild",
      "expired",
      (value) => (value.evaluatedAt = "2026-10-08T00:00:00.000Z"),
    ],
    missing: [
      "rebuild",
      "unavailable",
      (value) => (value.nodes[0].candidate = null),
    ],
    partial: [
      "reject",
      "partial",
      (value) =>
        unavailable(
          value.nodes[0].candidate.availability,
          "partial",
          "capsule-partial",
        ),
    ],
    "policy-drift": [
      "rebuild",
      "policy-changed",
      (value) => (value.nodes[0].expectedIdentity.policyRoot = ZERO_ROOT),
    ],
    "root-mismatch": [
      "reject",
      "root-mismatch",
      (value) =>
        unavailable(
          value.nodes[0].candidate.availability,
          "root-mismatch",
          "capsule-root-mismatch",
        ),
    ],
    "source-drift": [
      "rebuild",
      "source-changed",
      (value) => (value.nodes[0].expectedIdentity.sourceRoot = ZERO_ROOT),
    ],
    "stale-writer": [
      "contract-fault",
      "invalid-stage-capsule-authority",
      (value) =>
        (value.nodes[0].candidate.capsule.writerAuthority = "stale-writer"),
    ],
    "toolchain-drift": [
      "rebuild",
      "toolchain-changed",
      (value) =>
        (value.nodes[0].expectedIdentity.toolchainRoots[0].root = ZERO_ROOT),
    ],
  };
}

export function runV4StageCapsuleFaultCampaign(baseRequest) {
  const definitions = faultDefinitions();
  return V4_STAGE_CAPSULE_QUALIFICATION_FAULTS.map((id) => {
    const request = structuredClone(baseRequest);
    request.nodes = [request.nodes.find(({ key }) => key === "build")];
    request.nodes[0].dependencies = [];
    request.targets = ["build"];
    const [expected, expectedReason, mutate] = definitions[id];
    mutate(request);
    let actual = "contract-fault";
    let reasonCode = "unknown-fault";
    try {
      const decision = planV4StageCapsuleResume(request).decisions[0];
      actual = decision.decision;
      reasonCode = decision.reasonCode;
    } catch (error) {
      if (!(error instanceof V4ContractFault)) throw error;
      reasonCode = error.code;
    }
    return {
      id,
      expected,
      actual,
      reasonCode,
      passed: actual === expected && reasonCode === expectedReason,
    };
  });
}
