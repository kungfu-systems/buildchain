import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT =
  "buildchain-v4-stage-capsule-platform-qualification/v1";
export const V4_STAGE_CAPSULE_QUALIFICATION_CONTRACT =
  "buildchain-v4-stage-capsule-qualification/v1";
export const V4_STAGE_CAPSULE_WAVE_RECONCILIATION_CONTRACT =
  "buildchain-v4-stage-capsule-wave-reconciliation/v1";

const PLATFORMS = ["linux-x64", "macos-arm64", "windows-x64"];
const CONSUMERS = ["buildchain-self-dogfood", "kungfu-shadow"];
const FAULTS = [
  "corrupt",
  "cross-platform",
  "cross-stage",
  "expired",
  "missing",
  "partial",
  "policy-drift",
  "root-mismatch",
  "source-drift",
  "stale-writer",
  "toolchain-drift",
];
const CHILDREN = [
  "stage-capsule-contracts",
  "stage-capsule-store-retention",
  "platform-stage-checkpoints",
  "resume-planner",
  "stage-capsule-qualification-reconciliation",
];
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REVISION = /^[0-9a-f]{40}$/u;

function fault(code, location, message) {
  throw new V4ContractFault(code, location, message);
}

function object(value, location) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault(
      "invalid-stage-capsule-qualification-shape",
      location,
      "object required",
    );
  return value;
}

function exactKeys(value, expected, location) {
  object(value, location);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-stage-capsule-qualification-shape",
      location,
      "keys do not match the closed qualification contract",
    );
}

function token(value, location) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stage-capsule-qualification-token",
      location,
      "token required",
    );
}

function integer(value, location) {
  if (!Number.isSafeInteger(value) || value < 0)
    fault(
      "invalid-stage-capsule-qualification-metric",
      location,
      "non-negative integer required",
    );
}

function string(value, location) {
  if (typeof value !== "string" || value.length === 0)
    fault(
      "invalid-stage-capsule-qualification-value",
      location,
      "string required",
    );
}

function roots(value, names, location) {
  exactKeys(value, names, location);
  for (const name of names) validateV4Root(value[name], `${location}/${name}`);
}

function validateFaults(entries, location) {
  if (!Array.isArray(entries) || entries.length !== FAULTS.length)
    fault(
      "incomplete-stage-capsule-fault-campaign",
      location,
      "the complete fault campaign is required",
    );
  for (const [index, entry] of entries.entries()) {
    exactKeys(
      entry,
      ["id", "expected", "actual", "reasonCode", "passed"],
      `${location}/${index}`,
    );
    if (entry.id !== FAULTS[index] || entry.passed !== true)
      fault(
        "failed-stage-capsule-fault-campaign",
        `${location}/${index}`,
        "fault cases must be byte-sorted and pass",
      );
    for (const name of ["expected", "actual", "reasonCode"])
      token(entry[name], `${location}/${index}/${name}`);
  }
}

function validateAuthorityAndRuns(value) {
  if (
    value.schema !== V4_STAGE_CAPSULE_PLATFORM_QUALIFICATION_CONTRACT ||
    value.mode !== "shadow-only" ||
    value.productionAuthority !== "v3" ||
    value.providerEffects !== false ||
    value.productionWrites !== false
  )
    fault(
      "invalid-stage-capsule-qualification-authority",
      "$",
      "qualification cannot move v3 authority or enable effects",
    );
  if (!CONSUMERS.includes(value.consumer))
    fault(
      "invalid-stage-capsule-qualification-consumer",
      "$/consumer",
      "unknown consumer",
    );
  if (!PLATFORMS.includes(value.platform))
    fault(
      "invalid-stage-capsule-qualification-platform",
      "$/platform",
      "unknown platform",
    );
  string(value.runtimeRef, "$/runtimeRef");
  if (!Array.isArray(value.processRuns) || value.processRuns.length !== 2)
    fault(
      "invalid-stage-capsule-qualification-runs",
      "$/processRuns",
      "seed and resume runs are required",
    );
  const expectedRuns = [
    ["seed", "late-failure"],
    ["resume", "qualified"],
  ];
  for (const [index, run] of value.processRuns.entries()) {
    exactKeys(run, ["id", "outcome", "evidenceRoot"], `$/processRuns/${index}`);
    if (
      run.id !== expectedRuns[index][0] ||
      run.outcome !== expectedRuns[index][1]
    )
      fault(
        "invalid-stage-capsule-qualification-runs",
        `$/processRuns/${index}`,
        "run order or outcome differs",
      );
    validateV4Root(run.evidenceRoot, `$/processRuns/${index}/evidenceRoot`);
  }
}

function validateBuildAndPlan(value) {
  for (const [name, build] of [
    ["freshBuild", value.freshBuild],
    ["resumedBuild", value.resumedBuild],
  ])
    roots(build, ["artifactManifestRoot", "contentRoot"], `/${name}`);
  if (
    value.freshBuild.artifactManifestRoot !==
      value.resumedBuild.artifactManifestRoot ||
    value.freshBuild.contentRoot !== value.resumedBuild.contentRoot
  )
    fault(
      "stage-capsule-qualification-output-mismatch",
      "$/resumedBuild",
      "fresh and resumed outputs differ",
    );
  exactKeys(
    value.resumePlan,
    ["planRoot", "requiredRestores", "requiredStages"],
    "$/resumePlan",
  );
  validateV4Root(value.resumePlan.planRoot, "$/resumePlan/planRoot");
  for (const name of ["requiredRestores", "requiredStages"])
    if (
      !Array.isArray(value.resumePlan[name]) ||
      value.resumePlan[name].length === 0
    )
      fault(
        "invalid-stage-capsule-qualification-plan",
        `$/resumePlan/${name}`,
        "both retained and rebuilt stages are required",
      );
}

function validateMetricsAndRollback(value) {
  const metricNames = [
    "fullStageCount",
    "rebuiltStageCount",
    "retainedStageCount",
    "restoredStageCount",
    "retainedBytes",
    "restoreOverheadMs",
    "falseReuseCount",
    "falseRebuildCount",
  ];
  exactKeys(value.metrics, [...metricNames, "plannerAccurate"], "$/metrics");
  for (const name of metricNames)
    integer(value.metrics[name], `$/metrics/${name}`);
  if (
    value.metrics.fullStageCount !==
      value.metrics.rebuiltStageCount + value.metrics.retainedStageCount ||
    value.metrics.retainedStageCount < value.metrics.restoredStageCount ||
    value.metrics.restoredStageCount === 0 ||
    value.metrics.falseReuseCount !== 0 ||
    value.metrics.falseRebuildCount !== 0 ||
    value.metrics.plannerAccurate !== true
  )
    fault(
      "failed-stage-capsule-qualification-metrics",
      "$/metrics",
      "planner measurements do not qualify",
    );
  exactKeys(
    value.rollback,
    [
      "switch",
      "productionAuthority",
      "migrationRequired",
      "retainedStateDestroyed",
    ],
    "$/rollback",
  );
  if (
    value.rollback.switch !== "stage-capsule-mode=v3" ||
    value.rollback.productionAuthority !== "v3" ||
    value.rollback.migrationRequired !== false ||
    value.rollback.retainedStateDestroyed !== false
  )
    fault(
      "invalid-stage-capsule-qualification-rollback",
      "$/rollback",
      "rollback must remain one non-destructive v3 switch",
    );
}

export function validateV4StageCapsulePlatformQualification(value) {
  exactKeys(
    value,
    [
      "schema",
      "mode",
      "productionAuthority",
      "consumer",
      "platform",
      "runtimeRef",
      "processRuns",
      "freshBuild",
      "resumedBuild",
      "resumePlan",
      "faultCampaign",
      "metrics",
      "rollback",
      "providerEffects",
      "productionWrites",
      "reportRoot",
    ],
    "$",
  );
  validateAuthorityAndRuns(value);
  validateBuildAndPlan(value);
  validateFaults(value.faultCampaign, "$/faultCampaign");
  validateMetricsAndRollback(value);
  const payload = structuredClone(value);
  delete payload.reportRoot;
  const expectedRoot = v4ContentRoot(
    "stage-capsule-platform-qualification",
    payload,
  );
  if (value.reportRoot !== expectedRoot)
    fault(
      "stage-capsule-qualification-root-mismatch",
      "$/reportRoot",
      "reportRoot does not bind the platform qualification",
    );
  return value;
}

export function qualifyV4StageCapsuleCampaign(platformEvidence) {
  if (
    !Array.isArray(platformEvidence) ||
    platformEvidence.length !== PLATFORMS.length * CONSUMERS.length
  )
    fault(
      "incomplete-stage-capsule-platform-campaign",
      "$/platformEvidence",
      "both consumers must qualify on all three platforms",
    );
  const evidence = platformEvidence.map((entry) =>
    structuredClone(validateV4StageCapsulePlatformQualification(entry)),
  );
  const expectedPairs = CONSUMERS.flatMap((consumer) =>
    PLATFORMS.map((platform) => `${consumer}/${platform}`),
  );
  if (
    evidence.some(
      (entry, index) =>
        `${entry.consumer}/${entry.platform}` !== expectedPairs[index],
    )
  )
    fault(
      "incomplete-stage-capsule-platform-campaign",
      "$/platformEvidence",
      "platform reports must be unique and byte-sorted",
    );
  const consumers = [
    ...new Set(evidence.map(({ consumer }) => consumer)),
  ].sort();
  if (JSON.stringify(consumers) !== JSON.stringify(CONSUMERS))
    fault(
      "incomplete-stage-capsule-consumer-campaign",
      "$/platformEvidence",
      "Buildchain self-dogfood and Kungfu shadow evidence are required",
    );
  const body = {
    schema: V4_STAGE_CAPSULE_QUALIFICATION_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v3",
    platforms: evidence.map(({ platform, reportRoot }) => ({
      platform,
      reportRoot,
    })),
    consumers,
    qualified: true,
    falseReuseCount: evidence.reduce(
      (total, entry) => total + entry.metrics.falseReuseCount,
      0,
    ),
    falseRebuildCount: evidence.reduce(
      (total, entry) => total + entry.metrics.falseRebuildCount,
      0,
    ),
    productionWrites: false,
  };
  return {
    ...body,
    qualificationRoot: v4ContentRoot("stage-capsule-qualification", body),
  };
}

export function reconcileV4StageCapsuleWave(request) {
  exactKeys(
    request,
    ["schema", "qualificationRoot", "protectedDeliveryDrained", "children"],
    "$",
  );
  if (request.schema !== V4_STAGE_CAPSULE_WAVE_RECONCILIATION_CONTRACT)
    fault(
      "unsupported-stage-capsule-wave-reconciliation",
      "$/schema",
      "unsupported reconciliation contract",
    );
  validateV4Root(request.qualificationRoot, "$/qualificationRoot");
  if (request.protectedDeliveryDrained !== true)
    fault(
      "stage-capsule-protected-delivery-not-drained",
      "$/protectedDeliveryDrained",
      "protected delivery must be empty",
    );
  if (
    !Array.isArray(request.children) ||
    request.children.length !== CHILDREN.length
  )
    fault(
      "incomplete-stage-capsule-wave",
      "$/children",
      "all five Wave 2 children are required",
    );
  for (const [index, child] of request.children.entries()) {
    exactKeys(
      child,
      [
        "id",
        "nativeStatus",
        "nativeGateRoot",
        "sourceRevision",
        "protectedMergeRevision",
        "reviewRoot",
        "warrantRoot",
      ],
      `$/children/${index}`,
    );
    if (
      child.id !== CHILDREN[index] ||
      child.nativeStatus !== "terminal" ||
      !REVISION.test(child.sourceRevision) ||
      !REVISION.test(child.protectedMergeRevision)
    )
      fault(
        "incomplete-stage-capsule-wave",
        `$/children/${index}`,
        "child identity or terminal delivery is incomplete",
      );
    for (const name of ["nativeGateRoot", "reviewRoot", "warrantRoot"])
      validateV4Root(child[name], `$/children/${index}/${name}`);
  }
  const body = {
    schema: V4_STAGE_CAPSULE_WAVE_RECONCILIATION_CONTRACT,
    wave: 2,
    qualificationRoot: request.qualificationRoot,
    protectedDeliveryDrained: true,
    children: structuredClone(request.children),
    productionAuthority: "v3",
    productionReuseEnabled: false,
    residualResponsibilitiesOnly: true,
    terminal: true,
  };
  return {
    ...body,
    reconciliationRoot: v4ContentRoot(
      "stage-capsule-wave-reconciliation",
      body,
    ),
  };
}

export const V4_STAGE_CAPSULE_QUALIFICATION_PLATFORMS =
  Object.freeze(PLATFORMS);
export const V4_STAGE_CAPSULE_QUALIFICATION_FAULTS = Object.freeze(FAULTS);
export const V4_STAGE_CAPSULE_WAVE_CHILDREN = Object.freeze(CHILDREN);
