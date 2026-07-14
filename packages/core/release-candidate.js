import crypto from "node:crypto";
import { normalizeControllerReceiptReferences, validateControllerReceiptReference } from "./controller-evidence.js";

export const RELEASE_CANDIDATE_PASSPORT_CONTRACT = "kungfu-buildchain-release-candidate-passport";

function nowIso() {
  return new Date().toISOString();
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function nonEmptyString(value, label) {
  const normalized = optionalString(value).trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeTargetChannel(value) {
  const normalized = optionalString(value).trim();
  if (!normalized || normalized === "none") {
    return "";
  }
  const refMatch = normalized.match(/^(alpha|release)\/v\d+\/v\d+\.\d+$/);
  if (refMatch) {
    return refMatch[1];
  }
  if (normalized === "publish-gate/major" || normalized === "major-gate") {
    return "major";
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizePlatformEntry(platform = {}, index = 0) {
  const platformId = optionalString(platform.platform?.id || platform.platformId || platform.platform || `platform-${index}`);
  const artifacts = Array.isArray(platform.summary?.files)
    ? platform.summary.files
    : Array.isArray(platform.artifacts)
      ? platform.artifacts
      : [];
  return {
    platformId,
    artifactName: optionalString(platform.artifactName),
    runner: {
      labels: Array.isArray(platform.runner?.labels) ? platform.runner.labels.map(String) : [],
      os: optionalString(platform.runner?.os),
      arch: optionalString(platform.runner?.arch),
    },
    lifecycle: platform.observability?.lifecycle?.stages || {},
    summary: {
      fileCount: Number(platform.summary?.fileCount || 0),
      totalBytes: Number(platform.summary?.totalBytes || 0),
    },
    artifacts: artifacts.map((artifact, artifactIndex) => ({
      name: optionalString(artifact.name || artifact.path || `artifact-${artifactIndex}`),
      path: optionalString(artifact.path),
      size: Number(artifact.size || artifact.sizeBytes || 0),
      sha256: optionalString(artifact.sha256 || artifact.digest || artifact.checksum).replace(/^sha256:/, ""),
    })),
    manifestPath: optionalString(platform.manifestPath),
  };
}

function inferVersionFromReleaseManifest(buildSummary = {}) {
  const raw = buildSummary.publishSource?.releaseManifest || "";
  if (!raw) {
    return "";
  }
  try {
    const manifest = JSON.parse(raw);
    const versions = [
      ...new Set(
        (manifest.versionFiles || [])
          .map((file) => optionalString(file.version).trim())
          .filter(Boolean),
      ),
    ];
    return versions.length === 1 ? versions[0] : "";
  } catch {
    return "";
  }
}

function normalizeGateProfileEvidence(gateAggregate = undefined) {
  if (gateAggregate === undefined || gateAggregate === null || gateAggregate === "") return undefined;
  if (!gateAggregate || typeof gateAggregate !== "object" || Array.isArray(gateAggregate)) {
    throw new Error("gateAggregate must be an object");
  }
  if (gateAggregate.contract !== "buildchain.shifu-gate-aggregate/v1") {
    throw new Error("gateAggregate must use buildchain.shifu-gate-aggregate/v1");
  }
  const { digest, ...digestInput } = gateAggregate;
  const expectedDigest = `sha256:${sha256Json(digestInput)}`;
  if (digest !== expectedDigest) {
    throw new Error("gateAggregate digest does not match its content");
  }
  return {
    contract: gateAggregate.contract,
    digest,
    profile: nonEmptyString(gateAggregate.profile, "gateAggregate.profile"),
    sourceSha: nonEmptyString(gateAggregate.sourceSha, "gateAggregate.sourceSha"),
    registry: {
      projectId: nonEmptyString(gateAggregate.registry?.projectId, "gateAggregate.registry.projectId"),
      digest: nonEmptyString(gateAggregate.registry?.digest, "gateAggregate.registry.digest"),
    },
    matrixDigest: nonEmptyString(gateAggregate.matrixDigest, "gateAggregate.matrixDigest"),
    status: nonEmptyString(gateAggregate.status, "gateAggregate.status"),
    qualifying: gateAggregate.qualifying === true,
    receiptCount: Array.isArray(gateAggregate.receipts) ? gateAggregate.receipts.length : 0,
    gateResultCount: Array.isArray(gateAggregate.gates) ? gateAggregate.gates.length : 0,
  };
}

export function createReleaseCandidatePassport({
  repository = "",
  pullRequest = {},
  targetChannel = "",
  version = "",
  sourceHeadSha = "",
  baseSha = "",
  mergeRefSha = "",
  sourceTreeHash = "",
  buildSummary = {},
  buildchain = {},
  gateAggregate = undefined,
  controllerReceipts = [],
  controllerReceiptReferences = [],
  workflow = {},
  createdAt = nowIso(),
} = {}) {
  const normalizedSummary = buildSummary && typeof buildSummary === "object" ? buildSummary : {};
  const sourceSha = sourceHeadSha || normalizedSummary.publishSource?.sha || normalizedSummary.git?.sha || "";
  const resolvedTreeHash = optionalString(sourceTreeHash || normalizedSummary.git?.treeSha);
  const channel = normalizeTargetChannel(targetChannel)
    || normalizeTargetChannel(normalizedSummary.publishSource?.channel)
    || normalizeTargetChannel(normalizedSummary.publishGate?.channel)
    || normalizeTargetChannel(pullRequest.baseRef);
  const resolvedVersion = version || normalizedSummary.publishSource?.consumerVersion || inferVersionFromReleaseManifest(normalizedSummary);
  const gateProfileEvidence = normalizeGateProfileEvidence(gateAggregate);
  const controllerReceiptEvidence = normalizeControllerReceiptReferences({
    receipts: controllerReceipts,
    references: controllerReceiptReferences,
    expectedSourceSha: sourceSha,
    expectedRuntimeSha: optionalString(buildchain.sha || normalizedSummary.runtime?.sha),
    requirePassed: true,
  });
  const candidate = {
    schemaVersion: 1,
    contract: RELEASE_CANDIDATE_PASSPORT_CONTRACT,
    createdAt,
    repository: nonEmptyString(repository || normalizedSummary.git?.repository, "repository"),
    pullRequest: {
      number: optionalString(pullRequest.number),
      url: optionalString(pullRequest.url),
      headRef: optionalString(pullRequest.headRef),
      baseRef: optionalString(pullRequest.baseRef),
    },
    target: {
      channel: nonEmptyString(channel, "targetChannel"),
      ref: optionalString(normalizedSummary.publishSource?.ref || normalizedSummary.git?.ref),
      version: nonEmptyString(resolvedVersion, "version"),
    },
    source: {
      headSha: nonEmptyString(sourceSha, "sourceHeadSha"),
      baseSha: optionalString(baseSha),
      mergeRefSha: optionalString(mergeRefSha || sourceSha),
      treeHash: resolvedTreeHash,
      builtSourceSha: nonEmptyString(mergeRefSha || sourceSha, "builtSourceSha"),
      builtSourceTreeSha: resolvedTreeHash,
    },
    buildchain: {
      ref: optionalString(buildchain.ref || normalizedSummary.runtime?.ref),
      sha: optionalString(buildchain.sha || normalizedSummary.runtime?.sha),
      version: optionalString(buildchain.version),
      workflowShellRef: optionalString(buildchain.workflowShellRef || normalizedSummary.runtime?.workflowShellRef),
    },
    workflow: {
      name: optionalString(workflow.name),
      runId: optionalString(workflow.runId || normalizedSummary.git?.runId),
      runAttempt: optionalString(workflow.runAttempt || normalizedSummary.git?.runAttempt),
      url: optionalString(workflow.url),
    },
    platformMatrix: (Array.isArray(normalizedSummary.platforms) ? normalizedSummary.platforms : [])
      .map((platform, index) => normalizePlatformEntry(platform, index)),
    diagnostics: {
      buildSummaryContract: optionalString(normalizedSummary.contract),
      buildSummaryHash: sha256Json(normalizedSummary),
    },
    ...(gateProfileEvidence ? { gateProfileEvidence } : {}),
    ...(controllerReceiptEvidence.length > 0 ? { controllerReceipts: controllerReceiptEvidence } : {}),
  };
  candidate.candidateHash = sha256Json({
    repository: candidate.repository,
    target: candidate.target,
    source: candidate.source,
    platformMatrix: candidate.platformMatrix,
    buildchain: candidate.buildchain,
    ...(candidate.gateProfileEvidence ? { gateProfileEvidence: candidate.gateProfileEvidence } : {}),
    ...(candidate.controllerReceipts ? { controllerReceipts: candidate.controllerReceipts } : {}),
  });
  return candidate;
}

export function validateReleaseCandidatePassport({
  passport,
  repository = "",
  targetChannel = "",
  version = "",
  sourceHeadSha = "",
  buildSummary = undefined,
  requirePlatforms = true,
} = {}) {
  const errors = [];
  const check = (condition, message) => {
    if (!condition) {
      errors.push(message);
    }
  };
  check(passport && typeof passport === "object" && !Array.isArray(passport), "passport must be an object");
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    return { ok: false, errors };
  }
  check(passport.contract === RELEASE_CANDIDATE_PASSPORT_CONTRACT, `contract must be ${RELEASE_CANDIDATE_PASSPORT_CONTRACT}`);
  check(Number(passport.schemaVersion) === 1, "schemaVersion must be 1");
  if (repository) {
    check(passport.repository === repository, `repository mismatch: expected ${repository}, got ${passport.repository || "<empty>"}`);
  }
  if (targetChannel) {
    const expectedChannel = normalizeTargetChannel(targetChannel);
    const actualChannel = normalizeTargetChannel(passport.target?.channel);
    if (actualChannel) {
      check(actualChannel === expectedChannel, `target channel mismatch: expected ${expectedChannel}, got ${actualChannel}`);
    }
  }
  if (version) {
    check(passport.target?.version === version, `version mismatch: expected ${version}, got ${passport.target?.version || "<empty>"}`);
  }
  if (sourceHeadSha) {
    check(passport.source?.headSha === sourceHeadSha, `source head mismatch: expected ${sourceHeadSha}, got ${passport.source?.headSha || "<empty>"}`);
  }
  check(Boolean(passport.source?.mergeRefSha || passport.source?.treeHash), "source mergeRefSha or treeHash is required");
  check(Array.isArray(passport.platformMatrix), "platformMatrix must be an array");
  if (requirePlatforms) {
    check((passport.platformMatrix || []).length > 0, "platformMatrix must include at least one platform");
  }
  for (const [index, platform] of (passport.platformMatrix || []).entries()) {
    check(Boolean(platform.platformId), `platformMatrix[${index}].platformId is required`);
    check(Boolean(platform.artifactName), `platformMatrix[${index}].artifactName is required`);
  }
  if (buildSummary) {
    const expectedHash = sha256Json(buildSummary);
    check(passport.diagnostics?.buildSummaryHash === expectedHash, "build summary hash mismatch");
  }
  if (passport.gateProfileEvidence) {
    check(passport.gateProfileEvidence.contract === "buildchain.shifu-gate-aggregate/v1", "gate profile evidence contract mismatch");
    check(passport.gateProfileEvidence.sourceSha === passport.source?.headSha, "gate profile evidence source SHA mismatch");
    check(passport.gateProfileEvidence.status === "pass", "gate profile evidence status must be pass");
    check(passport.gateProfileEvidence.qualifying === true, "gate profile evidence must be qualifying");
    check(Boolean(passport.gateProfileEvidence.digest), "gate profile evidence digest is required");
    check(Boolean(passport.gateProfileEvidence.matrixDigest), "gate profile matrix digest is required");
  }
  if (passport.controllerReceipts !== undefined) {
    check(Array.isArray(passport.controllerReceipts), "controllerReceipts must be an array");
    const controllerIds = new Set();
    for (const [index, reference] of (passport.controllerReceipts || []).entries()) {
      const validation = validateControllerReceiptReference(reference, {
        expectedSourceSha: passport.source?.headSha || "",
        expectedRuntimeSha: passport.buildchain?.sha || "",
        requirePassed: true,
      });
      for (const issue of validation.issues) check(false, `controllerReceipts[${index}]: ${issue}`);
      check(!controllerIds.has(reference.controllerId), `controllerReceipts[${index}]: duplicate controller id ${reference.controllerId}`);
      controllerIds.add(reference.controllerId);
    }
  }
  return { ok: errors.length === 0, errors };
}
