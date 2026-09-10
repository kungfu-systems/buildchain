import {
  planArtifactPublish,
  assertTransactionIdentity,
  planTransactionRecovery,
  readPublishEvidence,
  validatePublishEvidence,
} from "../../publish-transaction.js";
import {
  getGitRefOrUndefined,
  getGitCommitWithRetry,
} from "./github-adapter.js";
import { assertSha } from "./promotion-policy.js";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { verifyPublicationSealedBundle } from "../../../publication/publication-sealed-bundle.js";
export function materialErrorRequiresRepair(error) {
  return /release_material_sha mismatch|source_sha mismatch|release_sha mismatch|version mismatch|target_ref mismatch|artifact digest mismatch|artifact coordinate or provenance mismatch|artifact provenance mismatch|artifact.*verification|verification\.|required artifact missing|duplicate publish artifact/.test(
    error.message || "",
  );
}
export function transactionHasPublishedMaterial(transaction) {
  return Boolean(
    (Array.isArray(transaction?.artifacts) &&
      transaction.artifacts.length > 0) ||
    (Array.isArray(transaction?.evidence) && transaction.evidence.length > 0),
  );
}
export function transactionCoversRequiredArtifacts(
  transaction,
  requiredArtifacts,
) {
  if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
    return true;
  }
  if (!transactionHasPublishedMaterial(transaction)) {
    return true;
  }
  return planArtifactPublish({
    requiredArtifacts,
    existingArtifacts: transaction.artifacts || [],
  }).complete;
}
export function ensureTransactionCanResume({
  existing,
  expected,
  explicitOverride,
  evidence,
  validation,
}) {
  if (!existing) {
    return;
  }
  assertTransactionIdentity(existing, expected, { allowToolingDrift: true });
  const recovery = planTransactionRecovery({
    transaction: existing,
    evidence,
    validation,
    explicitOverride,
  });
  if (recovery.blocked) {
    throw new Error(`release transaction cannot resume: ${recovery.reason}`);
  }
}
export async function canRebindPublishedTransactionExactTag({
  octokit,
  owner,
  repo,
  error,
  existing,
  validation,
  version,
  exactTag,
  releaseSha,
  releaseMaterialSha,
  requiredArtifacts,
}) {
  if (!/exact_tag mismatch/.test(error?.message || "")) {
    return false;
  }
  if (
    !existing ||
    existing.version !== version ||
    !existing.exact_tag ||
    existing.exact_tag === exactTag ||
    !["published", "finalizing"].includes(existing.state || "") ||
    !validation?.valid ||
    !transactionCoversRequiredArtifacts(existing, requiredArtifacts)
  ) {
    return false;
  }

  const previousTag = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `tags/${existing.exact_tag}`,
  });
  const transactionShas = new Set(
    [existing.release_sha, existing.release_material_sha].filter(Boolean),
  );
  if (previousTag?.object?.sha && transactionShas.has(previousTag.object.sha)) {
    return false;
  }

  const requestedTag = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `tags/${exactTag}`,
  });
  const acceptedRequestedTagShas = new Set(
    [
      releaseSha,
      releaseMaterialSha,
      existing.release_sha,
      existing.release_material_sha,
    ].filter(Boolean),
  );
  return (
    !requestedTag?.object?.sha ||
    acceptedRequestedTagShas.has(requestedTag.object.sha)
  );
}
export function canReplaceStaleVersionStateTransaction({
  error,
  existing,
  version,
  exactTag,
  targetRef,
  channel,
  allowVersionStateFinalization,
  explicitOverride,
  localOnly,
}) {
  if (!materialErrorRequiresRepair(error)) {
    return false;
  }
  if (localOnly) {
    return true;
  }
  if (!allowVersionStateFinalization && !explicitOverride) {
    return false;
  }
  if (transactionHasPublishedMaterial(existing)) {
    return false;
  }
  if (
    existing?.version !== version ||
    existing?.exact_tag !== exactTag ||
    existing?.target_ref !== targetRef ||
    existing?.channel !== channel
  ) {
    return false;
  }
  return !["complete", "abandoned", "failed_permanently"].includes(
    existing.state || "",
  );
}
export function validateTransactionEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  requiredArtifacts,
}) {
  const evidence = readPublishEvidence(evidencePath);
  if (!evidence) {
    throw new Error(`publish evidence missing: ${evidencePath}`);
  }
  const validation = validatePublishEvidence({
    evidence,
    version,
    channel,
    sourceSha,
    releaseSha,
    targetRef,
    releaseMaterialSha,
    publishToolingSha,
    requiredArtifacts,
  });
  if (!validation.valid) {
    throw new Error(
      `publish evidence invalid: ${validation.errors.join("; ")}`,
    );
  }
  return validation;
}
export async function releaseCommitIncludesTransactionHead({
  octokit,
  owner,
  repo,
  releaseSha,
  transactionReleaseSha,
}) {
  if (!octokit || !releaseSha || !transactionReleaseSha) {
    return false;
  }
  const seen = new Set();
  const queue = [releaseSha];
  while (queue.length > 0 && seen.size < 64) {
    const sha = queue.shift();
    if (!sha || seen.has(sha)) {
      continue;
    }
    if (sha === transactionReleaseSha) {
      return true;
    }
    seen.add(sha);
    const { data: commit } = await getGitCommitWithRetry({
      octokit,
      owner,
      repo,
      commitSha: sha,
    });
    for (const parent of commit.parents || []) {
      if (!seen.has(parent.sha)) {
        queue.push(parent.sha);
      }
    }
  }
  return false;
}
export async function releaseCommitMatchesTransactionMaterial({
  octokit,
  owner,
  repo,
  releaseSha,
  transactionReleaseShas,
}) {
  const { data: releaseCommit } = await getGitCommitWithRetry({
    octokit,
    owner,
    repo,
    commitSha: releaseSha,
  });
  for (const transactionReleaseSha of uniqueShas(transactionReleaseShas)) {
    if (
      !(await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha,
        transactionReleaseSha,
      }))
    )
      continue;
    const { data: transactionCommit } = await getGitCommitWithRetry({
      octokit,
      owner,
      repo,
      commitSha: transactionReleaseSha,
    });
    if (releaseCommit.tree?.sha === transactionCommit.tree?.sha) return true;
  }
  return false;
}
export function uniqueShas(values) {
  return [...new Set(values.filter(Boolean))];
}
export function transactionAcceptedExactTagShas(transaction, publicSha) {
  return uniqueShas([
    publicSha,
    transaction?.source_sha,
    transaction?.release_sha,
    transaction?.release_material_sha,
  ]);
}
export async function materializeTransactionSourceWorkspace({
  octokit,
  owner,
  repo,
  cwd,
  sourceSha,
}) {
  assertSha(sourceSha);
  const root = path.resolve(cwd, ".buildchain/transaction-finalization-source");
  const workspace = path.join(root, sourceSha);
  const archivePath = path.join(root, `${sourceSha}.tar.gz`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/tarball/{ref}",
    {
      owner,
      repo,
      ref: sourceSha,
    },
  );
  const archive = Buffer.isBuffer(response.data)
    ? response.data
    : response.data instanceof ArrayBuffer
      ? Buffer.from(response.data)
      : ArrayBuffer.isView(response.data)
        ? Buffer.from(
            response.data.buffer,
            response.data.byteOffset,
            response.data.byteLength,
          )
        : Buffer.from(response.data || "");
  if (archive.length === 0) {
    throw new Error(
      `Transaction source archive ${sourceSha} is empty; refusing cross-tree finalization`,
    );
  }
  fs.writeFileSync(archivePath, archive);
  execFileSync(
    "tar",
    ["-xzf", archivePath, "-C", workspace, "--strip-components=1"],
    { stdio: "pipe" },
  );
  fs.rmSync(archivePath, { force: true });
  return { root, workspace };
}
export function releaseTagForPublishedVersion(version = "") {
  const value = String(version || "").trim();
  if (!value) {
    return "";
  }
  return value.startsWith("v") ? value : `v${value}`;
}
export function publicReleaseTagForTransaction(transaction = {}) {
  return (
    releaseTagForPublishedVersion(transaction.version) ||
    transaction.exact_tag ||
    ""
  );
}
export function sealedBundleRecoveryRoot(cwd, version, requestedRoot = "") {
  if (requestedRoot) {
    return path.resolve(cwd, requestedRoot);
  }
  return path.join(
    cwd,
    ".buildchain",
    "recovered-publication",
    String(version || "unknown").replace(/[^0-9A-Za-z._-]+/g, "-"),
  );
}
export function readAndVerifySealedBundle({
  cwd,
  bundleRoot,
  manifestPath = "",
  manifest,
}) {
  const resolvedRoot = path.resolve(cwd, bundleRoot);
  const resolvedManifest =
    manifest ||
    (manifestPath
      ? JSON.parse(fs.readFileSync(path.resolve(cwd, manifestPath), "utf8"))
      : undefined);
  if (!resolvedManifest) {
    return undefined;
  }
  return verifyPublicationSealedBundle({
    bundleRoot: resolvedRoot,
    manifest: resolvedManifest,
  });
}
export function sealedBundleDurableFiles(verification) {
  if (!verification) {
    return [];
  }
  const durablePath = String(verification.manifest.durablePath || "").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (!durablePath || durablePath.split("/").includes("..")) {
    throw new Error("publication sealed bundle durablePath must be safe");
  }
  return verification.files.map((entry) => ({
    path: `${durablePath}/files/${entry.path}`,
    sourcePath: path.resolve(verification.bundleRoot, entry.path),
  }));
}
