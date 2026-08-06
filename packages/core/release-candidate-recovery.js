import {
  createControllerReceiptReference,
  validateControllerReceipt,
} from "./controller-evidence.js";
import {
  sha256Json,
  validateReleaseCandidatePassport,
} from "./release-candidate.js";
import { releaseTransactionId } from "./publish-transaction.js";

export const RELEASE_CANDIDATE_RECOVERY_CONTRACT =
  "kungfu-buildchain-release-candidate-recovery/v1";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TRUSTED_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);

export class ReleaseCandidateRecoveryError extends Error {
  constructor(code, message, nextAction) {
    super(message);
    this.name = "ReleaseCandidateRecoveryError";
    this.code = code;
    this.nextAction = nextAction;
  }
}

function fail(code, message, nextAction) {
  throw new ReleaseCandidateRecoveryError(code, message, nextAction);
}

function required(value, label, code = "invalid-recovery-input") {
  const normalized = String(value || "").trim();
  if (!normalized) fail(code, `${label} is required`, "Correct the recovery dispatch inputs and run a fresh recovery event.");
  return normalized;
}

function exactSha(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    fail("invalid-recovery-input", `${label} must be a 40-character Git SHA`, "Supply the exact immutable Git SHA.");
  }
  return normalized;
}

function contentRoot(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    fail("invalid-recovery-input", `${label} must be a sha256 content root`, "Supply the exact sha256 root from the sealed candidate evidence.");
  }
  return normalized;
}

function normalizeArtifact(record, index) {
  const name = required(record?.name, `artifacts[${index}].name`);
  if (record?.expired === true) {
    fail("artifact-expired", `candidate artifact is expired: ${name}`, "Create a new candidate explicitly; recovery never falls back to rebuilding.");
  }
  if (record?.missing === true) {
    fail("artifact-missing", `candidate artifact is missing: ${name}`, "Restore the immutable artifact if possible or explicitly create a new candidate.");
  }
  const size = Number(record?.size);
  const downloadedSize = Number(record?.downloadedSize);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(downloadedSize) || downloadedSize < 0) {
    fail("artifact-metadata-invalid", `candidate artifact size is invalid: ${name}`, "Inspect the candidate run artifact metadata and retry with a complete artifact set.");
  }
  const digest = contentRoot(record?.digest, `artifacts[${index}].digest`);
  const downloadedDigest = contentRoot(record?.downloadedDigest, `artifacts[${index}].downloadedDigest`);
  if (size !== downloadedSize || digest !== downloadedDigest) {
    fail("artifact-digest-mismatch", `candidate artifact archive differs from GitHub metadata: ${name}`, "Do not publish; preserve the run and investigate artifact corruption or replacement.");
  }
  const files = (record?.files || []).map((file, fileIndex) => {
    const fileSize = Number(file?.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      fail("artifact-manifest-mismatch", `${name} file ${fileIndex} has an invalid size`, "Inspect the platform manifest and product payload bytes.");
    }
    return {
      path: required(file?.path, `${name}.files[${fileIndex}].path`),
      size: fileSize,
      sha256: contentRoot(file?.sha256, `${name}.files[${fileIndex}].sha256`),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    fail("artifact-manifest-mismatch", `candidate artifact contains duplicate file paths: ${name}`, "Regenerate a valid candidate explicitly.");
  }
  return { name, size, digest, files, kind: String(record?.kind || "payload") };
}

function assertEqual(actual, expected, code, label, nextAction) {
  if (actual !== expected) fail(code, `${label} mismatch: expected ${expected}, got ${actual || "<empty>"}`, nextAction);
}

function normalizedRef(value) {
  return String(value || "").replace(/^refs\/heads\//, "").trim();
}

function sameArtifactFile(left, right) {
  return Boolean(left && right && left.size === right.size && left.sha256 === right.sha256);
}

function validatePlatformPayloads(passport, artifacts, platformManifests, platformManifestEvidence) {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const manifestsByArtifact = new Map((platformManifests || []).map((manifest) => [manifest.artifactName, manifest]));
  const evidenceByArtifact = new Map((platformManifestEvidence || []).map((evidence) => [evidence.artifactName, evidence]));
  if (manifestsByArtifact.size !== (passport.platformMatrix || []).length) {
    fail("platform-matrix-mismatch", "platform manifest count differs from the Passport platform matrix", "Restore every exact platform manifest from the candidate run.");
  }
  for (const platform of passport.platformMatrix || []) {
    const payload = byName.get(platform.artifactName);
    if (!payload) {
      fail("artifact-missing", `platform payload artifact is missing: ${platform.artifactName}`, "Restore the exact candidate artifact or explicitly create a new candidate.");
    }
    const passportFiles = (platform.artifacts || []).map((file) => ({
      path: String(file.path || file.name || ""),
      size: Number(file.size),
      sha256: `sha256:${String(file.sha256 || "").replace(/^sha256:/, "")}`,
    })).sort((left, right) => left.path.localeCompare(right.path));
    const manifest = manifestsByArtifact.get(platform.artifactName);
    if (!manifest) {
      fail("artifact-missing", `platform manifest is missing for ${platform.artifactName}`, "Restore the exact platform manifest artifact.");
    }
    const manifestFiles = (manifest.files || []).map((file) => ({
      path: String(file.path || file.name || ""),
      size: Number(file.size ?? file.bytes),
      sha256: `sha256:${String(file.sha256 || "").replace(/^sha256:/, "")}`,
    })).sort((left, right) => left.path.localeCompare(right.path));
    const platformId = required(platform.platformId, `${platform.artifactName}.platformId`);
    const buildchainEvidencePrefix = `.buildchain/artifacts/${platformId}/`;
    const manifestByPath = new Map(manifestFiles.map((file) => [file.path, file]));
    const evidenceFiles = new Map((evidenceByArtifact.get(platform.artifactName)?.files || []).map((file) => [file.path, file]));
    const payloadPaths = new Set(payload.files.map((file) => file.path));
    for (const manifestFile of manifestFiles) {
      if (!payloadPaths.has(manifestFile.path)) {
        fail("artifact-manifest-mismatch", `platform payload omits a manifest-declared file: ${platform.artifactName}/${manifestFile.path}`, "Do not publish; preserve the mismatched manifest and payload evidence.");
      }
    }
    for (const payloadFile of payload.files) {
      const manifestFile = manifestByPath.get(payloadFile.path);
      if (sameArtifactFile(payloadFile, manifestFile)) continue;
      const evidencePath = payloadFile.path.startsWith(buildchainEvidencePrefix)
        ? payloadFile.path.slice(buildchainEvidencePrefix.length)
        : "";
      const evidenceFile = evidencePath ? evidenceFiles.get(evidencePath) : undefined;
      if (!sameArtifactFile(payloadFile, evidenceFile)) {
        fail("artifact-manifest-mismatch", `platform payload contains unbound bytes or evidence drift: ${platform.artifactName}/${payloadFile.path}`, "Do not publish; preserve the platform payload, manifest, and independently uploaded evidence.");
      }
    }
    if (passportFiles.length > 0 && JSON.stringify(manifestFiles) !== JSON.stringify(passportFiles)) {
      fail("artifact-manifest-mismatch", `platform manifest differs from Passport inventory: ${platform.artifactName}`, "Do not publish; preserve the mismatched manifest and Passport evidence.");
    }
    if (
      Number(platform.summary?.fileCount) !== manifestFiles.length ||
      Number(platform.summary?.totalBytes) !== manifestFiles.reduce((total, file) => total + file.size, 0)
    ) {
      fail("platform-matrix-mismatch", `platform summary differs from manifest inventory: ${platform.artifactName}`, "Use the exact summary, manifest, and payload uploaded by the successful candidate run.");
    }
  }
}

function validateProductPayloads({ passport, artifacts, productPayloadManifests, candidateRoot, buildSummaryRoot, runtimeSha }) {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  for (const [index, manifest] of (productPayloadManifests || []).entries()) {
    if (manifest?.contract !== "kungfu-buildchain-product-payload-manifest/v1") {
      fail("artifact-manifest-mismatch", `product payload manifest ${index} has an invalid contract`, "Use the exact Buildchain-produced product payload manifest.");
    }
    const { root: _root, ...rootInput } = manifest;
    assertEqual(manifest.root, `sha256:${sha256Json(rootInput)}`, "artifact-manifest-mismatch", "product payload manifest root", "Use an untampered product payload manifest from the candidate run.");
    assertEqual(manifest.candidateRoot, candidateRoot, "candidate-root-mismatch", "product payload candidate root", "Use the product payload sealed for this exact candidate.");
    assertEqual(manifest.buildSummaryRoot, buildSummaryRoot, "build-summary-root-mismatch", "product payload build summary root", "Use the payload produced from the exact candidate summary.");
    assertEqual(manifest.source?.tree, passport.source?.treeHash, "source-tree-mismatch", "product payload source tree", "Use payload bytes produced from the exact candidate tree.");
    assertEqual(manifest.runtimeSha, runtimeSha, "runtime-mismatch", "product payload candidate runtime", "Use payload evidence created by the candidate runtime.");
    const artifact = byName.get(manifest.artifactName);
    if (!artifact) fail("artifact-missing", `product payload artifact is missing: ${manifest.artifactName}`, "Restore the exact product payload artifact.");
    const manifestName = String(manifest.manifestPath || "product-payload-manifest.json");
    const payloadFiles = artifact.files.filter((file) => file.path !== manifestName);
    const expectedFiles = (manifest.files || []).map((file) => ({
      path: String(file.path || ""),
      size: Number(file.size),
      sha256: String(file.sha256 || ""),
    })).sort((left, right) => left.path.localeCompare(right.path));
    if (JSON.stringify(payloadFiles) !== JSON.stringify(expectedFiles)) {
      fail("artifact-manifest-mismatch", `product payload bytes differ from their manifest: ${manifest.artifactName}`, "Do not publish; preserve the manifest and uploaded product bytes.");
    }
  }
}

function validateCandidateProvenance({
  candidateRepository,
  targetRepository,
  expectedRunId,
  expectedWorkflowFile,
  expectedWorkflowName,
  targetRef,
  run,
  workflow,
  pullRequest,
  ancestry,
}) {
  const repository = required(candidateRepository, "candidateRepository");
  assertEqual(repository, required(targetRepository, "targetRepository"), "repository-mismatch", "candidate repository", "Dispatch recovery in the repository that created the candidate.");
  assertEqual(String(run?.id || ""), required(expectedRunId, "expectedRunId"), "run-mismatch", "candidate run ID", "Select the exact successful candidate run.");
  assertEqual(run?.repository, repository, "repository-mismatch", "run repository", "Use a candidate run from the target repository.");
  assertEqual(run?.headRepository, repository, "provenance-insufficient", "run head repository", "Fork candidates are not recoverable; create a same-repository candidate.");
  if (run?.status !== "completed" || run?.conclusion !== "success" || run?.event !== "pull_request") {
    fail("untrusted-build-run", "candidate run must be a successful completed pull_request build", "Choose a successful allowed Build workflow run.");
  }
  const workflowFile = required(expectedWorkflowFile, "expectedWorkflowFile").replace(/^\.github\/workflows\//, "");
  const actualWorkflowPath = String(workflow?.path || run?.path || "").split("@")[0].replace(/^\.github\/workflows\//, "");
  assertEqual(actualWorkflowPath, workflowFile, "workflow-mismatch", "candidate workflow file", "Select a run from the documented trusted Build workflow.");
  assertEqual(String(workflow?.name || run?.name || ""), required(expectedWorkflowName, "expectedWorkflowName"), "workflow-mismatch", "candidate workflow name", "Select a run from the documented trusted Build workflow.");
  if (workflow?.state && workflow.state !== "active") fail("untrusted-build-run", `candidate workflow is not active: ${workflow.state}`, "Restore or select an allowed active Build workflow.");
  if (!TRUSTED_ASSOCIATIONS.has(String(pullRequest?.authorAssociation || ""))) fail("permission-evidence-insufficient", "candidate PR author lacks trusted repository association evidence", "Have a repository member create or approve a same-repository candidate PR.");
  assertEqual(pullRequest?.headRepository, repository, "provenance-insufficient", "candidate PR head repository", "Fork candidates are outside the recovery permission boundary.");
  if (!pullRequest?.merged) fail("pr-identity-invalid", "candidate PR is not merged", "Use a merged channel candidate PR.");
  assertEqual(normalizedRef(pullRequest?.baseRef), normalizedRef(targetRef), "target-mismatch", "candidate PR target ref", "Use the original release channel target.");
  const boundByNumber = Array.isArray(run?.pullRequestNumbers) && run.pullRequestNumbers.includes(Number(pullRequest?.number));
  const boundByHead = run?.headSha === pullRequest?.headSha && normalizedRef(run?.headBranch) === normalizedRef(pullRequest?.headRef);
  if (!boundByNumber && !boundByHead) fail("pr-identity-invalid", "candidate run is not bound to the merged candidate PR", "Select the exact PR-stage Build run.");
  if (!ancestry?.mergeIsAncestor && ancestry?.status !== "identical") fail("ancestry-invalid", "candidate merge is not an ancestor of the promotion SHA", "Promote a descendant of the verified merged candidate identity.");
  return { repository, workflowFile };
}

function validateCandidateIdentity({
  repository,
  channel,
  targetSha,
  targetTree,
  expectedSourceTree,
  expectedRuntimeSha,
  currentToolingSha,
  passport,
  buildSummary,
}) {
  const sha = exactSha(targetSha, "targetSha");
  const tree = exactSha(targetTree, "targetTree");
  const runtimeSha = exactSha(expectedRuntimeSha, "expectedRuntimeSha");
  const toolingSha = exactSha(currentToolingSha, "currentToolingSha");
  const validation = validateReleaseCandidatePassport({ passport, repository, targetChannel: channel, buildSummary });
  if (!validation.ok) fail("passport-invalid", `Release Candidate Passport validation failed: ${validation.errors.join("; ")}`, "Preserve the candidate evidence and explicitly create a new candidate after fixing the producer.");
  const expectedPassportHash = sha256Json({
    repository: passport.repository,
    target: passport.target,
    source: passport.source,
    platformMatrix: passport.platformMatrix,
    buildchain: passport.buildchain,
    ...(passport.gateProfileEvidence ? { gateProfileEvidence: passport.gateProfileEvidence } : {}),
    ...(passport.familyEvidence ? { familyEvidence: passport.familyEvidence } : {}),
    ...(passport.controllerReceipts ? { controllerReceipts: passport.controllerReceipts } : {}),
  });
  if (passport.candidateHash !== expectedPassportHash) fail("candidate-root-mismatch", "Release Candidate Passport candidate hash does not match its content", "Preserve the run evidence and explicitly create a new candidate after fixing the producer.");
  assertEqual(passport.source?.treeHash, tree, "source-tree-mismatch", "promotion Git tree", "Select a promotion SHA with the exact candidate Git tree or create a new candidate explicitly.");
  if (expectedSourceTree) assertEqual(passport.source?.treeHash, exactSha(expectedSourceTree, "expectedSourceTree"), "source-tree-mismatch", "expected source tree", "Correct the expected tree or create a new candidate.");
  assertEqual(passport.buildchain?.sha, runtimeSha, "runtime-mismatch", "candidate Buildchain runtime SHA", "Run recovery with the exact trusted Buildchain runtime recorded by the candidate.");
  return { sha, tree, runtimeSha, toolingSha };
}

function validateRecoveryTransaction({ existingTransaction, expectedTransactionId, repository, version, passport, sha, targetRef, candidateRoot }) {
  const actualTransactionId = String(existingTransaction?.id || "");
  if (expectedTransactionId && !actualTransactionId) fail("transaction-identity-conflict", `expected transaction ${expectedTransactionId} does not exist`, "Remove the stale transaction identity only if no durable transaction was ever sealed; otherwise preserve evidence and enter repair_required.");
  if (expectedTransactionId && expectedTransactionId !== actualTransactionId) fail("transaction-identity-conflict", `existing transaction ${actualTransactionId} conflicts with expected ${expectedTransactionId}`, "Enter repair_required and inspect the durable transaction before any retry.");
  if (existingTransaction) {
    const expectedIdentity = releaseTransactionId({ repository, version, sourceSha: sha, targetRef: normalizedRef(targetRef) });
    assertEqual(existingTransaction.id, expectedIdentity, "transaction-identity-conflict", "durable transaction identity", "Enter repair_required; the durable transaction does not belong to this exact publication target.");
    assertEqual(existingTransaction.repository, repository, "transaction-identity-conflict", "durable transaction repository", "Enter repair_required; never cross repository transaction boundaries.");
    assertEqual(normalizedRef(existingTransaction.target_ref), normalizedRef(targetRef), "transaction-identity-conflict", "durable transaction target ref", "Enter repair_required; never retarget a sealed transaction.");
    assertEqual(existingTransaction.source_sha, sha, "transaction-identity-conflict", "durable transaction source SHA", "Resume with the transaction's exact promotion SHA or enter repair_required.");
    assertEqual(existingTransaction.version, version, "transaction-identity-conflict", "durable transaction version", "Enter repair_required; never change a sealed publication version.");
    assertEqual(existingTransaction.channel, passport.target.channel, "transaction-identity-conflict", "durable transaction channel", "Enter repair_required; never move a transaction between channels.");
  }
  if (existingTransaction?.candidateRoot && existingTransaction.candidateRoot !== candidateRoot) fail("transaction-identity-conflict", "existing transaction is sealed to a different candidate root", "Enter repair_required; never reuse the conflicting transaction.");
  return actualTransactionId;
}

export function verifyReleaseCandidateRecovery({
  candidateRepository,
  targetRepository,
  expectedRunId,
  expectedWorkflowFile,
  expectedWorkflowName,
  channel,
  targetRef,
  targetSha,
  targetTree,
  expectedSourceTree = "",
  expectedCandidateRoot = "",
  expectedRuntimeSha,
  expectedTransactionId = "",
  existingTransaction = undefined,
  run,
  workflow,
  pullRequest,
  ancestry,
  passport,
  buildSummary,
  controllerReceipts = [],
  platformManifests = [],
  platformManifestEvidence = [],
  productPayloadManifests = [],
  artifacts = [],
  publicationVersion = "",
  currentToolingSha,
  recoveryRunId = "",
  createdAt = new Date().toISOString(),
} = {}) {
  const { repository, workflowFile } = validateCandidateProvenance({
    candidateRepository, targetRepository, expectedRunId, expectedWorkflowFile,
    expectedWorkflowName, targetRef, run, workflow, pullRequest, ancestry,
  });
  const { sha, tree, runtimeSha, toolingSha } = validateCandidateIdentity({
    repository, channel, targetSha, targetTree, expectedSourceTree,
    expectedRuntimeSha, currentToolingSha, passport, buildSummary,
  });

  const recoveredArtifacts = artifacts.map(normalizeArtifact).sort((left, right) => left.name.localeCompare(right.name));
  if (recoveredArtifacts.length === 0) fail("artifact-missing", "candidate artifact set is empty", "Select a retained run with the complete candidate artifact set.");
  if (new Set(recoveredArtifacts.map((artifact) => artifact.name)).size !== recoveredArtifacts.length) {
    fail("artifact-count-mismatch", "candidate artifact names are not unique", "Inspect the candidate run and remove ambiguity by creating a new candidate.");
  }
  validatePlatformPayloads(passport, recoveredArtifacts, platformManifests, platformManifestEvidence);

  const references = new Map((passport.controllerReceipts || []).map((reference) => [reference.controllerId, reference]));
  for (const receipt of controllerReceipts) {
    const receiptValidation = validateControllerReceipt(receipt, {
      expectedSourceSha: passport.source?.headSha,
      expectedRuntimeSha: runtimeSha,
    });
    if (!receiptValidation.ok || !receiptValidation.qualifying) {
      fail("controller-receipt-invalid", `controller receipt is not qualifying: ${receiptValidation.issues.join("; ")}`, "Use a successful candidate with complete controller evidence.");
    }
    const actualReference = createControllerReceiptReference(receipt);
    const expectedReference = references.get(actualReference.controllerId);
    if (!expectedReference || sha256Json(actualReference) !== sha256Json(expectedReference)) {
      fail("controller-receipt-mismatch", `controller receipt does not match Passport reference: ${actualReference.controllerId}`, "Use the exact controller receipt artifact uploaded by the candidate run.");
    }
  }
  if (references.size !== controllerReceipts.length) {
    fail("controller-receipt-missing", "not every Passport controller receipt was recovered", "Restore every referenced controller receipt artifact before recovery.");
  }

  const candidateRoot = `sha256:${passport.candidateHash}`;
  if (expectedCandidateRoot) assertEqual(candidateRoot, contentRoot(expectedCandidateRoot, "expectedCandidateRoot"), "candidate-root-mismatch", "candidate root", "Use the exact candidate root recorded by the original run.");
  const artifactInventory = recoveredArtifacts.map(({ name, size, digest, files }) => ({ name, size, digest, files }));
  const artifactRoot = `sha256:${sha256Json(artifactInventory)}`;
  const artifactArchiveRoot = `sha256:${sha256Json(recoveredArtifacts.map(({ name, size, digest }) => ({ name, size, digest })))}`;
  validateProductPayloads({
    passport,
    artifacts: recoveredArtifacts,
    productPayloadManifests,
    candidateRoot,
    buildSummaryRoot: `sha256:${passport.diagnostics.buildSummaryHash}`,
    runtimeSha,
  });

  const version = required(publicationVersion || passport.target?.version, "publicationVersion");
  const actualTransactionId = validateRecoveryTransaction({
    existingTransaction, expectedTransactionId, repository, version, passport, sha, targetRef, candidateRoot,
  });

  const receipt = {
    schemaVersion: 1,
    contract: RELEASE_CANDIDATE_RECOVERY_CONTRACT,
    action: "reused",
    createdAt,
    repository,
    recoveryRunId: String(recoveryRunId || ""),
    originalCandidate: {
      runId: String(run.id),
      workflowFile,
      workflowName: String(workflow?.name || run?.name || ""),
      pullRequest: Number(pullRequest.number),
      sourceSha: passport.source.headSha,
      mergeSha: String(pullRequest.mergeSha || ""),
      tree: passport.source.treeHash,
    },
    target: { channel: passport.target.channel, ref: normalizedRef(targetRef), sha, tree, version },
    recovered: {
      candidateRoot,
      buildSummaryRoot: `sha256:${passport.diagnostics.buildSummaryHash}`,
      artifactRoot,
      artifactArchiveRoot,
      artifactCount: recoveredArtifacts.length,
      artifacts: recoveredArtifacts.map(({ name, size, digest }) => ({ name, size, digest })),
    },
    skippedBuildStages: ["install", "build", "verify", "platform-matrix"],
    payloadBytes: "unchanged",
    buildchainToolingSha: toolingSha,
    transaction: {
      identity: expectedTransactionId || actualTransactionId || "",
      state: String(existingTransaction?.state || "absent"),
      publicationState: String(existingTransaction?.publication_state || existingTransaction?.state || "absent"),
    },
  };
  receipt.root = `sha256:${sha256Json(receipt)}`;
  return { receipt, artifacts: recoveredArtifacts };
}

export function recoveryFailure(error) {
  if (error instanceof ReleaseCandidateRecoveryError) {
    return { ok: false, code: error.code, reason: error.message, nextAction: error.nextAction };
  }
  return {
    ok: false,
    code: "recovery-internal-error",
    reason: String(error?.message || error),
    nextAction: "Preserve the run logs and candidate evidence; do not rebuild automatically.",
  };
}
