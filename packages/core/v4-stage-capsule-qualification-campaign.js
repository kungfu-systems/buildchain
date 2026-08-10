import fs from "node:fs";
import path from "node:path";

import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
} from "./v4-canonical-contracts.js";
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
const SELF_DOGFOOD_CONSUMER = "buildchain-self-dogfood";
const SELF_DOGFOOD_STAGES = Object.freeze(["install", "verify"]);
const SELF_DOGFOOD_DEPENDENCIES = Object.freeze({
  install: [],
  verify: ["install"],
});
const SELF_DOGFOOD_EXCLUSIONS = Object.freeze({
  publish: "provider-mutation",
  "version-state": "generated-output-mutation",
});
const EXTERNAL_CONSUMER_STAGES = Object.freeze(["install", "build", "verify"]);
const EXTERNAL_CONSUMER_DEPENDENCIES = Object.freeze({
  install: [],
  build: ["install"],
  verify: ["build"],
});
const EXTERNAL_CONSUMER_EXCLUSIONS = Object.freeze({
  publish: "provider-mutation",
});

function rootOf(label) {
  return v4StageCapsuleBlobRoot(
    Buffer.isBuffer(label)
      ? label
      : typeof label === "string"
        ? Buffer.from(`${label}\n`, "utf8")
        : v4CanonicalBytes(label),
  );
}

function outputBytes(context, stageId, outputName) {
  const evidence = context.campaignProfile?.stageEvidence?.[stageId];
  if (evidence) return v4CanonicalBytes(evidence);
  return Buffer.from(
    `${context.consumer}:${context.consumerSourceRevision}:${context.platform}:${stageId}:${outputName}:qualified-bytes\n`,
    "utf8",
  );
}

function inputRoot(context, stageId, name) {
  const stageInputs = context.campaignProfile?.inputRoots?.[stageId];
  if (stageInputs?.[name]) return stageInputs[name];
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

function campaignFault(code, location, message) {
  throw new V4ContractFault(code, location, message);
}

function readJson(file, label) {
  if (!fs.existsSync(file))
    campaignFault(
      "missing-stage-capsule-lifecycle-evidence",
      label,
      `${label} does not exist`,
    );
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    campaignFault(
      "invalid-stage-capsule-lifecycle-evidence",
      label,
      `${label} is not valid JSON: ${error.message}`,
    );
  }
}

function lifecycleStageEvidence({ stageId, manifest, summary, command }) {
  if (
    manifest?.contract !== "kungfu-buildchain-artifact" ||
    manifest.lifecycle?.stage !== stageId ||
    manifest.lifecycle?.commandSource !== "buildchain.toml" ||
    manifest.lifecycle?.executed !== true
  )
    campaignFault(
      "invalid-stage-capsule-lifecycle-evidence",
      `$/lifecycle/${stageId}/manifest`,
      "manifest must prove the executed buildchain.toml lifecycle stage",
    );
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some(
      (entry) =>
        typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256),
    )
  )
    campaignFault(
      "invalid-stage-capsule-lifecycle-output",
      `$/lifecycle/${stageId}/manifest/files`,
      "at least one exact lifecycle output root is required",
    );
  if (
    summary?.contract !== "kungfu-buildchain-artifact-summary" ||
    summary?.artifactName !== manifest.artifactName ||
    summary?.platform?.id !== manifest.platform?.id ||
    summary?.fileCount !== manifest.files.length ||
    summary?.totalBytes !==
      manifest.files.reduce((total, entry) => total + entry.size, 0) ||
    JSON.stringify(summary) !== JSON.stringify(manifest.summary)
  )
    campaignFault(
      "stage-capsule-lifecycle-summary-mismatch",
      `$/lifecycle/${stageId}/summary`,
      "summary does not match the lifecycle manifest",
    );
  const body = {
    schema: "buildchain-v4-real-lifecycle-stage-evidence/v1",
    stage: stageId,
    commands: command.commands || [command.script],
    manifestRoot: rootOf(manifest),
    summaryRoot: rootOf(summary),
    outputRoots: manifest.files
      .map(({ path: filePath, size, sha256 }) => ({
        path: filePath,
        root: `sha256:${sha256}`,
        size,
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
  return {
    ...body,
    evidenceRoot: rootOf(body),
  };
}

export function createV4StageCapsuleCampaignProfile(context) {
  if (!context.lifecycleConfig) {
    const body = {
      schema: "buildchain-v4-stage-capsule-campaign-profile/v1",
      kind: "consumer-equivalent-fixture",
      stages: V4_STAGE_CAPSULE_CAMPAIGN_STAGES,
      dependencies: V4_STAGE_CAPSULE_CAMPAIGN_DEPENDENCIES,
    };
    return {
      ...body,
      profileRoot: rootOf(body),
    };
  }

  const loaded = context.lifecycleConfig;
  const selfDogfood = context.consumer === SELF_DOGFOOD_CONSUMER;
  const executableStages = selfDogfood
    ? SELF_DOGFOOD_STAGES
    : EXTERNAL_CONSUMER_STAGES;
  const dependencies = selfDogfood
    ? SELF_DOGFOOD_DEPENDENCIES
    : EXTERNAL_CONSUMER_DEPENDENCIES;
  const exclusions = selfDogfood
    ? SELF_DOGFOOD_EXCLUSIONS
    : EXTERNAL_CONSUMER_EXCLUSIONS;
  if (!loaded?.filePath || !loaded?.config)
    campaignFault(
      "missing-stage-capsule-lifecycle-config",
      "$/lifecycleConfig",
      "Buildchain self-dogfood requires an explicitly loaded lifecycle config",
    );
  const lifecycle = loaded?.config?.lifecycle || {};
  const stageNames = Object.keys(lifecycle).filter(
    (name) => !["env", "shell"].includes(name),
  );
  const unexpected = stageNames.filter(
    (name) => !executableStages.includes(name) && !exclusions[name],
  );
  if (
    executableStages.some((name) => !stageNames.includes(name)) ||
    unexpected.length > 0
  )
    campaignFault(
      "unsupported-stage-capsule-lifecycle-graph",
      "$/lifecycle",
      "real lifecycle stages differ from the fail-closed canary policy",
    );
  if (!context.lifecycleEvidenceRoot)
    campaignFault(
      "missing-stage-capsule-lifecycle-evidence",
      "$/lifecycleEvidenceRoot",
      "real lifecycle canary requires lifecycle evidence",
    );

  const stageEvidence = Object.fromEntries(
    executableStages.map((stageId) => {
      const manifest = readJson(
        path.join(context.lifecycleEvidenceRoot, `${stageId}-manifest.json`),
        `$/lifecycle/${stageId}/manifest`,
      );
      const summary = readJson(
        path.join(context.lifecycleEvidenceRoot, `${stageId}-summary.json`),
        `$/lifecycle/${stageId}/summary`,
      );
      if (
        manifest.platform?.id !== context.platform ||
        manifest.git?.sha !== context.consumerSourceRevision
      )
        campaignFault(
          "stage-capsule-lifecycle-source-mismatch",
          `$/lifecycle/${stageId}/manifest`,
          "lifecycle evidence does not match the requested platform and source",
        );
      return [
        stageId,
        lifecycleStageEvidence({
          stageId,
          manifest,
          summary,
          command: lifecycle[stageId],
        }),
      ];
    }),
  );
  const configBytes = fs.readFileSync(loaded.filePath);
  const sourceRoot = rootOf({
    configRoot: rootOf(configBytes),
    sourceRevision: context.consumerSourceRevision,
  });
  const installOutputRoot = v4StageCapsuleBlobRoot(
    v4CanonicalBytes(stageEvidence.install),
  );
  const buildOutputRoot = stageEvidence.build
    ? v4StageCapsuleBlobRoot(v4CanonicalBytes(stageEvidence.build))
    : installOutputRoot;
  const lifecycleDeclarations = stageNames.map((name) => ({
    name,
    commands: lifecycle[name].commands || [lifecycle[name].script],
    disposition: executableStages.includes(name)
      ? "shadow-executed"
      : exclusions[name],
  }));
  const body = {
    schema: "buildchain-v4-stage-capsule-campaign-profile/v1",
    kind: selfDogfood
      ? "real-buildchain-lifecycle"
      : "real-external-consumer-lifecycle",
    configPath: loaded.path,
    configRoot: rootOf(configBytes),
    stages: executableStages,
    dependencies,
    lifecycleDeclarations,
    stageEvidence,
    productionAuthority: "v3",
    providerEffects: false,
  };
  return {
    ...body,
    inputRoots: {
      install: {
        lockfile: installOutputRoot,
        "source-tree": sourceRoot,
      },
      ...(stageEvidence.build
        ? {
            build: {
              "dependency-layout": installOutputRoot,
              "source-tree": sourceRoot,
            },
          }
        : {}),
      verify: {
        "build-output": buildOutputRoot,
        "source-tree": sourceRoot,
      },
    },
    profileRoot: rootOf(body),
  };
}

export function v4StageCapsuleCampaignStages(context) {
  return context.campaignProfile?.stages || V4_STAGE_CAPSULE_CAMPAIGN_STAGES;
}

export function v4StageCapsuleCampaignDependencies(context, stageId) {
  return (
    context.campaignProfile?.dependencies?.[stageId] ||
    V4_STAGE_CAPSULE_CAMPAIGN_DEPENDENCIES[stageId]
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
      stage.inputs.map((name) => [name, inputRoot(context, stageId, name)]),
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
      campaignProfileRoot: context.campaignProfile.profileRoot,
    },
    transformation: {
      interface: context.campaignProfile.kind.startsWith("real-")
        ? context.campaignProfile.kind
        : "consumer-equivalent",
      providerEffects: false,
      stage: stageId,
      lifecycleEvidenceRoot:
        context.campaignProfile.stageEvidence?.[stageId]?.evidenceRoot || null,
    },
    qualification: {
      exactBytes: true,
      consumer: context.consumer,
      productionBytesChanged: false,
      campaignProfileRoot: context.campaignProfile.profileRoot,
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
    const faultNode =
      request.nodes.find(({ key }) => key === "build") ||
      request.nodes.find(({ candidate }) => candidate !== null);
    request.nodes = [faultNode];
    request.nodes[0].dependencies = [];
    request.targets = [faultNode.key];
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
