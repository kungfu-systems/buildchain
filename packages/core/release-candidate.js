import crypto from "node:crypto";
import { verifyV4FloatingConsumerPolicyReceipt } from "./v4-floating-consumer-policy.js";
import { normalizeControllerReceiptReferences, validateControllerReceiptReference } from "./controller-evidence.js";

export const RELEASE_CANDIDATE_PASSPORT_CONTRACT = "kungfu-buildchain-release-candidate-passport";
export const FAMILY_RELEASE_EVIDENCE_CONTRACT = "kungfu-buildchain-initiative-family-release-evidence/v1";

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

function sha256Root(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return normalized;
}

function gitSha(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return normalized;
}

function sortedUniqueRoots(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const roots = value.map((root, index) => sha256Root(root, `${label}[${index}]`));
  const expected = [...new Set(roots)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (roots.length !== expected.length || roots.some((root, index) => root !== expected[index])) {
    throw new Error(`${label} must be sorted and duplicate-free`);
  }
  return roots;
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an invalid field set`);
  }
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

function isV4BuildchainRuntime(buildchain = {}) {
  return [buildchain.ref, buildchain.workflowShellRef]
    .some((value) => /^v4(?:-alpha)?$/u.test(String(value || "")))
    || /^4\./u.test(String(buildchain.version || ""));
}

function normalizeConsumerPolicyEvidence(value, expected = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("consumerPolicyReceipt must be an object");
  }
  const receipt = value.receipt || value;
  const verification = verifyV4FloatingConsumerPolicyReceipt({
    receipt,
    receiptRoot: value.receiptRoot || "",
    repository: expected.repository,
    sourceSha: expected.sourceSha,
    resolvedRuntimeSha: expected.runtimeSha,
  });
  if (!verification.ok) {
    throw new Error(`consumer policy receipt invalid: ${verification.failures.map((failure) => failure.code).join(", ")}`);
  }
  return { receiptRoot: verification.receiptRoot, receipt };
}

function validateConsumerPolicyEvidence(passport, check) {
  if (isV4BuildchainRuntime(passport.buildchain)) {
    check(Boolean(passport.consumerPolicy), "Buildchain v4 release candidate requires consumer policy evidence");
  }
  if (!passport.consumerPolicy) return;
  const verification = verifyV4FloatingConsumerPolicyReceipt({
    receipt: passport.consumerPolicy.receipt,
    receiptRoot: passport.consumerPolicy.receiptRoot,
    repository: passport.repository,
    sourceSha: passport.source?.headSha,
    resolvedRuntimeSha: passport.buildchain?.sha,
  });
  for (const failure of verification.failures) {
    check(false, `consumer policy evidence invalid: ${failure.code}`);
  }
}

function validateEvidenceBoundCandidateHash(passport, check) {
  if (!passport.familyEvidence && !passport.consumerPolicy) return;
  const expectedCandidateHash = sha256Json({
    repository: passport.repository,
    target: passport.target,
    source: passport.source,
    platformMatrix: passport.platformMatrix,
    buildchain: passport.buildchain,
    ...(passport.gateProfileEvidence ? { gateProfileEvidence: passport.gateProfileEvidence } : {}),
    ...(passport.familyEvidence ? { familyEvidence: passport.familyEvidence } : {}),
    ...(passport.consumerPolicy ? { consumerPolicy: passport.consumerPolicy } : {}),
    ...(passport.controllerReceipts ? { controllerReceipts: passport.controllerReceipts } : {}),
  });
  check(passport.candidateHash === expectedCandidateHash, "candidate hash mismatch");
}

function normalizeFamilyReleaseEvidence(value = undefined) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("familyEvidence must be an object");
  }
  if (value.contract !== FAMILY_RELEASE_EVIDENCE_CONTRACT) {
    throw new Error(`familyEvidence.contract must be ${FAMILY_RELEASE_EVIDENCE_CONTRACT}`);
  }
  requireExactKeys(
    value,
    ["contract", "initiative", "child", "source", "qualification", "terminal", "continuation", "artifact", "release", "invalidation", "evidenceRoot"],
    "familyEvidence",
  );
  requireExactKeys(value.initiative, ["initiativeId", "versionRoot", "familyStateRoot"], "familyEvidence.initiative");
  requireExactKeys(value.child, ["assignmentId", "workDefinitionRoot", "deliveryClass"], "familyEvidence.child");
  requireExactKeys(value.source, ["commitSha", "treeSha", "sourceRoot"], "familyEvidence.source");
  requireExactKeys(value.qualification, ["status", "proofRoot", "qualificationRoot"], "familyEvidence.qualification");
  requireExactKeys(value.terminal, ["state", "terminalRoot", "evidenceRoots"], "familyEvidence.terminal");
  requireExactKeys(value.artifact, ["artifactRoot"], "familyEvidence.artifact");
  requireExactKeys(value.release, ["releaseRoot"], "familyEvidence.release");
  requireExactKeys(value.invalidation, ["status", "roots"], "familyEvidence.invalidation");
  const terminalState = nonEmptyString(value.terminal?.state, "familyEvidence.terminal.state");
  if (!["merged", "continued"].includes(terminalState)) {
    throw new Error("familyEvidence.terminal.state must be merged or continued");
  }
  const deliveryClass = nonEmptyString(value.child?.deliveryClass, "familyEvidence.child.deliveryClass");
  if (deliveryClass !== "release") {
    throw new Error("familyEvidence.child.deliveryClass must be release");
  }
  const continuation = value.continuation === null || value.continuation === undefined
    ? null
    : {
        successorAssignmentId: nonEmptyString(
          value.continuation.successorAssignmentId,
          "familyEvidence.continuation.successorAssignmentId",
        ),
        requestRoot: sha256Root(value.continuation.requestRoot, "familyEvidence.continuation.requestRoot"),
        completedEvidenceRoots: sortedUniqueRoots(
          value.continuation.completedEvidenceRoots,
          "familyEvidence.continuation.completedEvidenceRoots",
        ),
        residualResponsibilityRoot: sha256Root(
          value.continuation.residualResponsibilityRoot,
          "familyEvidence.continuation.residualResponsibilityRoot",
        ),
      };
  if (value.continuation !== null) {
    requireExactKeys(
      value.continuation,
      ["successorAssignmentId", "requestRoot", "completedEvidenceRoots", "residualResponsibilityRoot"],
      "familyEvidence.continuation",
    );
  }
  if (terminalState === "continued" && !continuation) {
    throw new Error("continued family evidence requires an exact residual successor");
  }
  if (terminalState === "merged" && continuation) {
    throw new Error("merged family evidence must not declare a residual successor");
  }
  const normalized = {
    contract: FAMILY_RELEASE_EVIDENCE_CONTRACT,
    initiative: {
      initiativeId: nonEmptyString(value.initiative?.initiativeId, "familyEvidence.initiative.initiativeId"),
      versionRoot: sha256Root(value.initiative?.versionRoot, "familyEvidence.initiative.versionRoot"),
      familyStateRoot: sha256Root(value.initiative?.familyStateRoot, "familyEvidence.initiative.familyStateRoot"),
    },
    child: {
      assignmentId: nonEmptyString(value.child?.assignmentId, "familyEvidence.child.assignmentId"),
      workDefinitionRoot: sha256Root(value.child?.workDefinitionRoot, "familyEvidence.child.workDefinitionRoot"),
      deliveryClass,
    },
    source: {
      commitSha: gitSha(value.source?.commitSha, "familyEvidence.source.commitSha"),
      treeSha: gitSha(value.source?.treeSha, "familyEvidence.source.treeSha"),
      sourceRoot: sha256Root(value.source?.sourceRoot, "familyEvidence.source.sourceRoot"),
    },
    qualification: {
      status: nonEmptyString(value.qualification?.status, "familyEvidence.qualification.status"),
      proofRoot: sha256Root(value.qualification?.proofRoot, "familyEvidence.qualification.proofRoot"),
      qualificationRoot: sha256Root(
        value.qualification?.qualificationRoot,
        "familyEvidence.qualification.qualificationRoot",
      ),
    },
    terminal: {
      state: terminalState,
      terminalRoot: sha256Root(value.terminal?.terminalRoot, "familyEvidence.terminal.terminalRoot"),
      evidenceRoots: sortedUniqueRoots(
        value.terminal?.evidenceRoots,
        "familyEvidence.terminal.evidenceRoots",
      ),
    },
    continuation,
    artifact: {
      artifactRoot: sha256Root(value.artifact?.artifactRoot, "familyEvidence.artifact.artifactRoot"),
    },
    release: {
      releaseRoot: sha256Root(value.release?.releaseRoot, "familyEvidence.release.releaseRoot"),
    },
    invalidation: {
      status: nonEmptyString(value.invalidation?.status, "familyEvidence.invalidation.status"),
      roots: sortedUniqueRoots(value.invalidation?.roots, "familyEvidence.invalidation.roots", { allowEmpty: true }),
    },
  };
  if (normalized.qualification.status !== "qualified") {
    throw new Error("familyEvidence.qualification.status must be qualified");
  }
  if (normalized.invalidation.status !== "clear" || normalized.invalidation.roots.length > 0) {
    throw new Error("familyEvidence must not contain invalidated evidence");
  }
  const requiredTerminalRoots = [
    normalized.source.sourceRoot,
    normalized.qualification.proofRoot,
    normalized.qualification.qualificationRoot,
    normalized.artifact.artifactRoot,
    normalized.release.releaseRoot,
  ];
  for (const root of requiredTerminalRoots) {
    if (!normalized.terminal.evidenceRoots.includes(root)) {
      throw new Error(`familyEvidence.terminal.evidenceRoots is missing ${root}`);
    }
  }
  if (continuation) {
    for (const root of [normalized.artifact.artifactRoot, normalized.release.releaseRoot]) {
      if (!continuation.completedEvidenceRoots.includes(root)) {
        throw new Error(`familyEvidence.continuation.completedEvidenceRoots is missing ${root}`);
      }
    }
  }
  const evidenceRoot = `sha256:${sha256Json(normalized)}`;
  if (sha256Root(value.evidenceRoot, "familyEvidence.evidenceRoot") !== evidenceRoot) {
    throw new Error("familyEvidence.evidenceRoot does not match its content");
  }
  return { ...normalized, evidenceRoot };
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
  familyEvidence = undefined,
  consumerPolicyReceipt = undefined,
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
  const normalizedFamilyEvidence = normalizeFamilyReleaseEvidence(familyEvidence);
  const resolvedBuildchain = {
    ref: optionalString(buildchain.ref || normalizedSummary.runtime?.ref),
    sha: optionalString(buildchain.sha || normalizedSummary.runtime?.sha),
    version: optionalString(buildchain.version),
    workflowShellRef: optionalString(buildchain.workflowShellRef || normalizedSummary.runtime?.workflowShellRef),
  };
  const normalizedConsumerPolicy = normalizeConsumerPolicyEvidence(consumerPolicyReceipt, {
    repository: repository || normalizedSummary.git?.repository || "",
    sourceSha,
    runtimeSha: resolvedBuildchain.sha,
  });
  if (isV4BuildchainRuntime(resolvedBuildchain) && !normalizedConsumerPolicy) {
    throw new Error("Buildchain v4 release candidate passport requires a valid floating consumer policy receipt");
  }
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
    buildchain: resolvedBuildchain,
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
    ...(normalizedFamilyEvidence ? { familyEvidence: normalizedFamilyEvidence } : {}),
    ...(normalizedConsumerPolicy ? { consumerPolicy: normalizedConsumerPolicy } : {}),
    ...(controllerReceiptEvidence.length > 0 ? { controllerReceipts: controllerReceiptEvidence } : {}),
  };
  candidate.candidateHash = sha256Json({
    repository: candidate.repository,
    target: candidate.target,
    source: candidate.source,
    platformMatrix: candidate.platformMatrix,
    buildchain: candidate.buildchain,
    ...(candidate.gateProfileEvidence ? { gateProfileEvidence: candidate.gateProfileEvidence } : {}),
    ...(candidate.familyEvidence ? { familyEvidence: candidate.familyEvidence } : {}),
    ...(candidate.consumerPolicy ? { consumerPolicy: candidate.consumerPolicy } : {}),
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
  requireFamilyEvidence = false,
  familyEvidenceRoot = "",
  familyInitiativeId = "",
  familyAssignmentId = "",
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
  validateConsumerPolicyEvidence(passport, check);
  if (requireFamilyEvidence || familyEvidenceRoot || familyInitiativeId || familyAssignmentId) {
    check(Boolean(passport.familyEvidence), "family evidence is required");
  }
  if (passport.familyEvidence) {
    try {
      const normalized = normalizeFamilyReleaseEvidence(passport.familyEvidence);
      check(
        normalized.source.commitSha === passport.source?.headSha
          || normalized.source.commitSha === passport.source?.mergeRefSha,
        "family evidence source commit does not match the release candidate",
      );
      check(
        normalized.source.treeSha === passport.source?.treeHash,
        "family evidence source tree does not match the release candidate",
      );
      if (familyEvidenceRoot) {
        check(
          normalized.evidenceRoot === familyEvidenceRoot,
          `family evidence root mismatch: expected ${familyEvidenceRoot}, got ${normalized.evidenceRoot}`,
        );
      }
      if (familyInitiativeId) {
        check(
          normalized.initiative.initiativeId === familyInitiativeId,
          `family initiative mismatch: expected ${familyInitiativeId}, got ${normalized.initiative.initiativeId}`,
        );
      }
      if (familyAssignmentId) {
        check(
          normalized.child.assignmentId === familyAssignmentId,
          `family assignment mismatch: expected ${familyAssignmentId}, got ${normalized.child.assignmentId}`,
        );
      }
    } catch (error) {
      check(false, `family evidence invalid: ${error.message || error}`);
    }
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
  validateEvidenceBoundCandidateHash(passport, check);
  return { ok: errors.length === 0, errors };
}
