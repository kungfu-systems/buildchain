import {
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_TAIL_RESEAL_PLAN_CONTRACT,
  V4_TAIL_RESEAL_PLATFORMS as PLATFORM_IDS,
  V4_TAIL_RESEAL_PLATFORM_RUNNERS as PLATFORM_RUNNERS,
  V4_TAIL_RESEAL_REQUEST_CONTRACT,
  V4_TAIL_RESEAL_REUSED_STAGE_KEYS as REUSED_STAGE_KEYS,
} from "./v4-tail-reseal-contract.js";

export {
  V4_TAIL_RESEAL_PLAN_CONTRACT,
  V4_TAIL_RESEAL_REQUEST_CONTRACT,
} from "./v4-tail-reseal-contract.js";

const SHA = /^[0-9a-f]{40}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const V4_RUNTIME_REF = /^(?:v4-alpha|train\/v4\/v4\.0\/[A-Za-z0-9._/-]+)$/u;

export class V4TailResealFault extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = "V4TailResealFault";
    this.code = code;
    this.path = path;
  }
}

function fault(code, path, message) {
  throw new V4TailResealFault(code, path, message);
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-tail-reseal-shape", path, "object required");
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-tail-reseal-shape",
      path,
      "keys do not match the closed tail-reseal contract",
    );
}

function token(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault("invalid-tail-reseal-token", path, "ASCII identity token required");
  return value;
}

function text(value, path) {
  if (typeof value !== "string" || value.trim() === "")
    fault("invalid-tail-reseal-text", path, "non-empty string required");
  return value.trim();
}

function artifactPath(value, path) {
  const normalized = text(value, path).replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.startsWith(".buildchain/tail-reseal")
  )
    fault(
      "invalid-tail-reseal-artifact-path",
      path,
      "artifact paths must be safe relative payload paths",
    );
  return normalized;
}

function sha(value, path) {
  if (typeof value !== "string" || !SHA.test(value))
    fault("invalid-tail-reseal-sha", path, "exact lowercase Git SHA required");
  return value;
}

function root(value, path) {
  try {
    validateV4Root(value, path);
  } catch (error) {
    fault("invalid-tail-reseal-root", path, error.message);
  }
  return value;
}

function clock(value, path) {
  try {
    validateV4Clock(value, path);
  } catch (error) {
    fault("invalid-tail-reseal-clock", path, error.message);
  }
  return value;
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1)
    fault(
      "invalid-tail-reseal-integer",
      path,
      "positive safe integer required",
    );
  return value;
}

function sortedUnique(values, path, validate = token) {
  if (!Array.isArray(values) || values.length === 0)
    fault("invalid-tail-reseal-shape", path, "non-empty array required");
  const normalized = values.map((value, index) =>
    validate(value, `${path}/${index}`),
  );
  const canonical = [...new Set(normalized)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    normalized.length !== canonical.length ||
    normalized.some((value, index) => value !== canonical[index])
  )
    fault(
      "unordered-tail-reseal-evidence",
      path,
      "values must be byte-sorted and duplicate-free",
    );
  return normalized;
}

function validateSource(value) {
  exactKeys(
    value,
    [
      "runId",
      "runAttempt",
      "sha",
      "treeSha",
      "sourceRoot",
      "workflowFile",
      "workflowName",
    ],
    "$/source",
  );
  positiveInteger(value.runId, "$/source/runId");
  positiveInteger(value.runAttempt, "$/source/runAttempt");
  sha(value.sha, "$/source/sha");
  sha(value.treeSha, "$/source/treeSha");
  root(value.sourceRoot, "$/source/sourceRoot");
  text(value.workflowFile, "$/source/workflowFile");
  text(value.workflowName, "$/source/workflowName");
}

function validateTarget(value) {
  exactKeys(value, ["channel", "ref", "baseSha", "version"], "$/target");
  if (value.channel !== "alpha" || value.ref !== "alpha/v4/v4.0")
    fault(
      "tail-reseal-target-mismatch",
      "$/target",
      "tail reseal is limited to alpha/v4/v4.0",
    );
  sha(value.baseSha, "$/target/baseSha");
  if (!/^4\.0\.0-alpha\.\d+$/u.test(value.version))
    fault(
      "tail-reseal-target-mismatch",
      "$/target/version",
      "v4 Alpha version required",
    );
}

function validateRuntime(value) {
  exactKeys(
    value,
    ["repository", "ref", "sha", "contractRoot", "consumerPolicyReceiptRoot"],
    "$/runtime",
  );
  if (value.repository !== "kungfu-systems/buildchain")
    fault(
      "tail-reseal-runtime-mismatch",
      "$/runtime/repository",
      "official Buildchain runtime required",
    );
  if (!V4_RUNTIME_REF.test(value.ref))
    fault(
      "tail-reseal-runtime-mismatch",
      "$/runtime/ref",
      "v4-alpha or a transient v4 train is required",
    );
  sha(value.sha, "$/runtime/sha");
  root(value.contractRoot, "$/runtime/contractRoot");
  root(value.consumerPolicyReceiptRoot, "$/runtime/consumerPolicyReceiptRoot");
}

function validateWarrant(value) {
  exactKeys(
    value,
    [
      "candidateId",
      "generation",
      "fencingToken",
      "status",
      "lineageRoot",
      "qualificationRoot",
      "stateReadbackRoot",
    ],
    "$/warrant",
  );
  token(value.candidateId, "$/warrant/candidateId");
  positiveInteger(value.generation, "$/warrant/generation");
  token(value.fencingToken, "$/warrant/fencingToken");
  if (value.status !== "qualified")
    fault(
      "tail-reseal-warrant-ineligible",
      "$/warrant/status",
      "exact qualified Warrant required",
    );
  root(value.lineageRoot, "$/warrant/lineageRoot");
  root(value.qualificationRoot, "$/warrant/qualificationRoot");
  root(value.stateReadbackRoot, "$/warrant/stateReadbackRoot");
}

function validateRetention(value, evaluatedAt) {
  exactKeys(
    value,
    ["status", "retainUntil", "policyRoot", "readbackRoot"],
    "$/retention",
  );
  if (value.status !== "retained")
    fault(
      "tail-reseal-retention-invalid",
      "$/retention/status",
      "retained artifact status required",
    );
  clock(value.retainUntil, "$/retention/retainUntil");
  if (Date.parse(value.retainUntil) <= Date.parse(evaluatedAt))
    fault(
      "tail-reseal-retention-expired",
      "$/retention/retainUntil",
      "retention must extend beyond evaluation",
    );
  root(value.policyRoot, "$/retention/policyRoot");
  root(value.readbackRoot, "$/retention/readbackRoot");
}

function validateFailure(value) {
  exactKeys(
    value,
    [
      "platformId",
      "stage",
      "jobId",
      "jobName",
      "stepName",
      "code",
      "evidenceRoot",
    ],
    "$/failure",
  );
  const exactFailure =
    value.platformId === "macos-arm64" &&
    value.stage === "signing-finalization" &&
    value.jobName === "build / Finalize signed artifact macOS ARM64" &&
    value.stepName === "Recompute manifest over final signed bytes";
  if (!exactFailure)
    fault(
      "tail-reseal-failure-mismatch",
      "$/failure",
      "single known macOS signing-finalization failure required",
    );
  positiveInteger(value.jobId, "$/failure/jobId");
  token(value.code, "$/failure/code");
  root(value.evidenceRoot, "$/failure/evidenceRoot");
}

function validateStageResume(value) {
  exactKeys(
    value,
    ["planRoot", "qualificationRoot", "zeroEffectReuse", "decisions"],
    "$/stageResume",
  );
  root(value.planRoot, "$/stageResume/planRoot");
  root(value.qualificationRoot, "$/stageResume/qualificationRoot");
  if (value.zeroEffectReuse !== true)
    fault(
      "tail-reseal-capsule-effect",
      "$/stageResume/zeroEffectReuse",
      "Stage Capsule reuse must remain effect-pure",
    );
  if (!Array.isArray(value.decisions))
    fault(
      "invalid-tail-reseal-shape",
      "$/stageResume/decisions",
      "array required",
    );
  const stageKeys = [];
  for (const [index, decision] of value.decisions.entries()) {
    const path = `$/stageResume/decisions/${index}`;
    exactKeys(
      decision,
      ["stageKey", "decision", "capsuleRoot", "evidenceRoot"],
      path,
    );
    stageKeys.push(token(decision.stageKey, `${path}/stageKey`));
    if (decision.decision !== "reuse")
      fault(
        "tail-reseal-rebuild-required",
        `${path}/decision`,
        "all pre-tail stages must be exact reusable capsules",
      );
    root(decision.capsuleRoot, `${path}/capsuleRoot`);
    root(decision.evidenceRoot, `${path}/evidenceRoot`);
  }
  if (JSON.stringify(stageKeys) !== JSON.stringify(REUSED_STAGE_KEYS))
    fault(
      "tail-reseal-stage-coverage-mismatch",
      "$/stageResume/decisions",
      "exact install, build, verify, and package reuse proof is required for every platform",
    );
}

function validateSigning(value, evaluatedAt) {
  exactKeys(
    value,
    [
      "authorityRepository",
      "authorityRunId",
      "runtimeSha",
      "requestRoot",
      "delegationRoot",
      "resultArtifact",
      "resultArtifactRoot",
      "credentialAuthorityId",
      "credentialScopeRoot",
      "credentialLeaseRoot",
      "credentialExpiresAt",
      "providerReadbackRoot",
    ],
    "$/signing",
  );
  text(value.authorityRepository, "$/signing/authorityRepository");
  positiveInteger(value.authorityRunId, "$/signing/authorityRunId");
  sha(value.runtimeSha, "$/signing/runtimeSha");
  for (const field of [
    "requestRoot",
    "delegationRoot",
    "resultArtifactRoot",
    "credentialScopeRoot",
    "credentialLeaseRoot",
    "providerReadbackRoot",
  ])
    root(value[field], `$/signing/${field}`);
  text(value.resultArtifact, "$/signing/resultArtifact");
  token(value.credentialAuthorityId, "$/signing/credentialAuthorityId");
  clock(value.credentialExpiresAt, "$/signing/credentialExpiresAt");
  if (Date.parse(value.credentialExpiresAt) <= Date.parse(evaluatedAt))
    fault(
      "tail-reseal-credential-expired",
      "$/signing/credentialExpiresAt",
      "live credential authority is required",
    );
}

function validateReleaseTail(value) {
  exactKeys(
    value,
    [
      "declarationRoot",
      "transactionRoot",
      "operationRoot",
      "idempotencyKey",
      "providerReadbackRoot",
    ],
    "$/releaseTail",
  );
  for (const field of [
    "declarationRoot",
    "transactionRoot",
    "operationRoot",
    "providerReadbackRoot",
  ])
    root(value[field], `$/releaseTail/${field}`);
  token(value.idempotencyKey, "$/releaseTail/idempotencyKey");
}

function validatePlatforms(values) {
  if (!Array.isArray(values) || values.length !== PLATFORM_IDS.length)
    fault(
      "tail-reseal-platform-mismatch",
      "$/platforms",
      "exact four-platform candidate required",
    );
  const ids = [];
  const names = new Set();
  for (const [index, value] of values.entries()) {
    const path = `$/platforms/${index}`;
    exactKeys(
      value,
      [
        "id",
        "name",
        "runner",
        "artifactName",
        "artifactRoot",
        "artifactArchiveRoot",
        "manifestArtifactName",
        "manifestRoot",
        "manifestArchiveRoot",
        "artifactPaths",
        "capsuleRoot",
      ],
      path,
    );
    ids.push(token(value.id, `${path}/id`));
    text(value.name, `${path}/name`);
    text(value.runner, `${path}/runner`);
    if (value.runner !== PLATFORM_RUNNERS[value.id])
      fault(
        "tail-reseal-runner-mismatch",
        `${path}/runner`,
        "platform runner differs from the declared v4 platform authority",
      );
    for (const field of ["artifactName", "manifestArtifactName"]) {
      const name = text(value[field], `${path}/${field}`);
      if (names.has(name))
        fault(
          "tail-reseal-artifact-ambiguous",
          `${path}/${field}`,
          "artifact names must be unique",
        );
      names.add(name);
    }
    root(value.artifactRoot, `${path}/artifactRoot`);
    root(value.artifactArchiveRoot, `${path}/artifactArchiveRoot`);
    root(value.manifestRoot, `${path}/manifestRoot`);
    root(value.manifestArchiveRoot, `${path}/manifestArchiveRoot`);
    const artifactPaths = sortedUnique(
      value.artifactPaths,
      `${path}/artifactPaths`,
      artifactPath,
    );
    if (artifactPaths.length !== 2)
      fault(
        "tail-reseal-artifact-path-mismatch",
        `${path}/artifactPaths`,
        "exactly two declared payload roots are required",
      );
    root(value.capsuleRoot, `${path}/capsuleRoot`);
  }
  if (JSON.stringify(ids) !== JSON.stringify(PLATFORM_IDS))
    fault(
      "tail-reseal-platform-mismatch",
      "$/platforms",
      `platforms must be byte-ordered as ${PLATFORM_IDS.join(", ")}`,
    );
}

export function normalizeV4TailResealRequest(request) {
  exactKeys(
    request,
    [
      "schema",
      "evaluatedAt",
      "repository",
      "source",
      "target",
      "runtime",
      "warrant",
      "retention",
      "failure",
      "stageResume",
      "signing",
      "releaseTail",
      "platforms",
    ],
    "$",
  );
  if (request.schema !== V4_TAIL_RESEAL_REQUEST_CONTRACT)
    fault(
      "unsupported-tail-reseal-version",
      "$/schema",
      "unsupported v4 tail-reseal request",
    );
  clock(request.evaluatedAt, "$/evaluatedAt");
  text(request.repository, "$/repository");
  validateSource(request.source);
  validateTarget(request.target);
  validateRuntime(request.runtime);
  validateWarrant(request.warrant);
  validateRetention(request.retention, request.evaluatedAt);
  validateFailure(request.failure);
  validateStageResume(request.stageResume);
  validateSigning(request.signing, request.evaluatedAt);
  validateReleaseTail(request.releaseTail);
  validatePlatforms(request.platforms);
  if (request.signing.runtimeSha !== request.runtime.sha)
    fault(
      "tail-reseal-signing-runtime-mismatch",
      "$/signing/runtimeSha",
      "signing authority runtime differs from candidate runtime",
    );
  const capsuleRoots = new Map(
    request.platforms.map((platform) => [platform.id, platform.capsuleRoot]),
  );
  for (const decision of request.stageResume.decisions) {
    const platformId = decision.stageKey.split(":", 1)[0];
    if (decision.capsuleRoot !== capsuleRoots.get(platformId))
      fault(
        "tail-reseal-capsule-mismatch",
        "$/stageResume/decisions",
        `Stage Capsule root drifted for ${platformId}`,
      );
  }
  return structuredClone(request);
}

export function planV4TailReseal(request) {
  const normalized = normalizeV4TailResealRequest(request);
  const payload = {
    schema: V4_TAIL_RESEAL_PLAN_CONTRACT,
    mode: "production",
    productionAuthority: "v4",
    evaluatedAt: normalized.evaluatedAt,
    repository: normalized.repository,
    sourceRoot: normalized.source.sourceRoot,
    runtimeSha: normalized.runtime.sha,
    warrantLineageRoot: normalized.warrant.lineageRoot,
    stageResumePlanRoot: normalized.stageResume.planRoot,
    retainedPlatformRoots: normalized.platforms.map((platform) => ({
      platformId: platform.id,
      artifactRoot: platform.artifactRoot,
      artifactArchiveRoot: platform.artifactArchiveRoot,
      manifestRoot: platform.manifestRoot,
      manifestArchiveRoot: platform.manifestArchiveRoot,
      capsuleRoot: platform.capsuleRoot,
    })),
    skippedStages: ["build", "install", "package", "platform-matrix", "verify"],
    rerunStages: [
      "macos-signing-finalization",
      "aggregate",
      "candidate-passport",
      "protected-readback",
    ],
    capsuleReuse: {
      authority: "content-addressed-stage-capsule",
      effectAuthority: "none",
      zeroExternalMutations: true,
      qualificationRoot: normalized.stageResume.qualificationRoot,
    },
    signingEffect: {
      authority: "explicit-live-release-tail",
      platformId: "macos-arm64",
      operationRoot: normalized.releaseTail.operationRoot,
      idempotencyKey: normalized.releaseTail.idempotencyKey,
      fencedBy: [
        normalized.warrant.stateReadbackRoot,
        normalized.signing.credentialLeaseRoot,
        normalized.releaseTail.transactionRoot,
      ].sort(),
      providerReadbackRoots: [
        normalized.signing.providerReadbackRoot,
        normalized.releaseTail.providerReadbackRoot,
      ].sort(),
    },
    passport: {
      contract: "kungfu-buildchain-release-candidate-passport",
      consumerPolicyReceiptRoot: normalized.runtime.consumerPolicyReceiptRoot,
      sourceSha: normalized.source.sha,
      version: normalized.target.version,
    },
    invalidationConditions: [
      "artifact-byte-drift",
      "credential-authority-drift",
      "manifest-drift",
      "platform-drift",
      "prior-failure-drift",
      "retention-expired",
      "signer-authority-drift",
      "source-drift",
      "warrant-lineage-drift",
    ],
  };
  return {
    ...payload,
    planRoot: v4ContentRoot("tail-reseal-plan", payload),
  };
}

export {
  V4_TAIL_RESEAL_PLATFORMS,
  V4_TAIL_RESEAL_REUSED_STAGE_KEYS,
} from "./v4-tail-reseal-contract.js";
