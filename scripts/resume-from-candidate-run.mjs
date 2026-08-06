#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeGitHubOutputs } from "./build-contract-core.mjs";
import {
  generatePublishRequiredArtifacts,
  readNpmPackageArtifact,
  selectReleaseCandidateArtifacts,
} from "./release-candidate-resolver.mjs";
import {
  githubDownload,
  githubJson,
  unzip,
  verifyArtifactArchive,
} from "./release-candidate-resolver.mjs";
import {
  recoveryFailure,
  validateRecoveryTargetRef,
  verifyReleaseCandidateRecovery,
} from "../packages/core/release-candidate-recovery.js";
import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication-sealed-bundle.js";
import { releaseTransactionStateRef } from "../packages/core/publish-transaction.js";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requiredEnv(name) {
  const value = env(name).trim();
  if (!value) throw new Error(`${name} is required for candidate recovery`);
  return value;
}

function splitRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`candidate repository must be owner/repo, got ${repository || "<empty>"}`);
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function splitPatterns(value = "") {
  return String(value || "").split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
}

function patternMatcher(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function safeName(value) {
  return String(value || "artifact").replace(/[^A-Za-z0-9._-]/g, "_");
}

function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function collectFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const pending = [resolvedRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push({
        path: path.relative(resolvedRoot, fullPath).split(path.sep).join("/"),
        size: fs.statSync(fullPath).size,
        sha256: sha256File(fullPath),
        absolutePath: fullPath,
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function findFiles(root, predicate) {
  return collectFiles(root).filter((file) => predicate(file.path, file.absolutePath));
}

function readOnlyJson(files, label) {
  if (files.length !== 1) throw new Error(`expected exactly one ${label}, found ${files.length}`);
  return JSON.parse(fs.readFileSync(files[0].absolutePath, "utf8"));
}

async function readExistingTransaction({ repoInfo, apiUrl, token, fetchImpl, version }) {
  const stateRef = releaseTransactionStateRef(version);
  const response = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    allowNotFound: true,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/contents/state.json?ref=${encodeURIComponent(stateRef)}`,
  });
  if (!response) return undefined;
  if (response.type !== "file" || response.encoding !== "base64" || !response.content) {
    throw new Error(`durable transaction ${stateRef} did not expose a base64 state.json file`);
  }
  return JSON.parse(Buffer.from(String(response.content).replace(/\s/g, ""), "base64").toString("utf8"));
}

function outputPath(filePath) {
  const relative = path.relative(process.cwd(), filePath).split(path.sep).join("/");
  return relative.startsWith("../") ? filePath : relative;
}

async function downloadArtifact({ artifact, repoInfo, apiUrl, token, archiveDir, bundleRoot, fetchImpl }) {
  const name = safeName(artifact.name);
  const archivePath = path.join(archiveDir, `${name}.zip`);
  const artifactRoot = path.join(bundleRoot, "artifacts", name);
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: archivePath,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${artifact.id}/zip`,
  });
  const archive = verifyArtifactArchive({ artifact, archivePath });
  unzip(archivePath, artifactRoot);
  const files = collectFiles(artifactRoot);
  return {
    artifact,
    artifactRoot,
    record: {
      name: artifact.name,
      kind: "candidate",
      size: Number(artifact.size_in_bytes),
      downloadedSize: archive.size,
      digest: artifact.digest,
      downloadedDigest: archive.digest,
      expired: artifact.expired === true,
      files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
    },
    files,
  };
}

function candidateArtifactNames({ passport, selected, artifacts, artifactPatterns }) {
  const names = new Set([selected.passport.name, selected.summary.name]);
  for (const reference of passport.controllerReceipts || []) {
    if (!reference.artifact) throw new Error(`Passport controller receipt ${reference.controllerId} has no artifact identity`);
    names.add(reference.artifact);
  }
  for (const platform of passport.platformMatrix || []) {
    names.add(platform.artifactName);
    const diagnosticsArtifactName = `${selected.prefix}-diagnostics-${platform.platformId}-${selected.sourceSha}`;
    if (artifacts.some((artifact) => artifact.name === diagnosticsArtifactName)) names.add(diagnosticsArtifactName);
  }
  const manifestPattern = new RegExp(`^${selected.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-manifest-.+-${selected.sourceSha}$`);
  for (const artifact of artifacts) {
    if (manifestPattern.test(String(artifact.name || ""))) names.add(artifact.name);
  }
  const matchers = splitPatterns(artifactPatterns).map(patternMatcher);
  for (const artifact of artifacts) {
    if (matchers.some((matcher) => matcher.test(String(artifact.name || "")))) names.add(artifact.name);
  }
  return names;
}

function normalizePlatformManifests(downloads, passport) {
  const manifests = [];
  const evidenceByArtifact = new Map();
  function addEvidence(artifactName, files) {
    if (!artifactName) return;
    const evidenceFiles = evidenceByArtifact.get(artifactName) || new Map();
    for (const file of files) {
      const existing = evidenceFiles.get(file.path);
      if (existing && (existing.size !== file.size || existing.sha256 !== file.sha256)) {
        throw new Error(`platform evidence disagrees for ${artifactName}/${file.path}`);
      }
      evidenceFiles.set(file.path, file);
    }
    evidenceByArtifact.set(artifactName, evidenceFiles);
  }
  for (const download of downloads) {
    if (String(download.artifact.name).includes("-manifest-")) for (const file of download.files.filter((entry) => path.basename(entry.path) === "manifest.json")) {
      const manifest = JSON.parse(fs.readFileSync(file.absolutePath, "utf8"));
      if (!manifest.artifactName) {
        const platformId = String(manifest.platform?.id || manifest.platformId || "");
        manifest.artifactName = (passport.platformMatrix || []).find((entry) => entry.platformId === platformId)?.artifactName || "";
      }
      manifests.push(manifest);
      addEvidence(manifest.artifactName, download.record.files);
    }
    if (String(download.artifact.name).includes("-diagnostics-")) {
      const diagnosticsFiles = download.files.filter((entry) => path.basename(entry.path) === "diagnostics.json");
      if (diagnosticsFiles.length === 1) {
        const diagnostics = JSON.parse(fs.readFileSync(diagnosticsFiles[0].absolutePath, "utf8"));
        addEvidence(String(diagnostics.links?.artifactName || ""), download.record.files);
      }
    }
  }
  const evidence = [...evidenceByArtifact].map(([artifactName, files]) => ({
    artifactName,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  }));
  return { manifests, evidence };
}

function normalizeControllerReceipts(downloads, passport) {
  const artifactNames = new Set((passport.controllerReceipts || []).map((reference) => reference.artifact));
  const receipts = [];
  for (const download of downloads.filter((entry) => artifactNames.has(entry.artifact.name))) {
    const candidates = download.files.filter((file) => file.path.endsWith(".json")).map((file) => {
      try { return JSON.parse(fs.readFileSync(file.absolutePath, "utf8")); } catch { return undefined; }
    }).filter((value) => value?.contract === "buildchain.controller-evidence/v1" && value?.kind === "receipt");
    if (candidates.length !== 1) throw new Error(`controller artifact ${download.artifact.name} must contain exactly one controller receipt`);
    receipts.push(candidates[0]);
  }
  return receipts;
}

function normalizeProductPayloadManifests(downloads) {
  return downloads.flatMap((download) => download.files
    .filter((file) => path.basename(file.path) === "product-payload-manifest.json")
    .map((file) => JSON.parse(fs.readFileSync(file.absolutePath, "utf8"))));
}

export function createRecoveredPublicationCandidate({
  allFiles,
  repository,
  passport,
  candidateRuntimeSha,
}) {
  if (passport.buildchain?.sha !== candidateRuntimeSha) {
    throw new Error(
      `recovered publication candidate runtime mismatch: passport=${passport.buildchain?.sha || "<empty>"} expected=${candidateRuntimeSha || "<empty>"}`,
    );
  }
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository,
    sourceSha: passport.source.headSha,
    sourceTreeSha: passport.source.treeHash,
    runtimeSha: candidateRuntimeSha,
    releaseCandidateRoot: `sha256:${passport.candidateHash}`,
    files: allFiles.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
  };
  return { ...payload, candidateDigest: publicationArtifactCandidateDigest(payload) };
}

function createSealedBundle({ downloads, bundleRoot, repository, passport, candidateRuntimeSha, publishPackageMain, releasePatterns }) {
  const allFiles = downloads.flatMap((download) => download.files.map((file) => ({
    path: path.relative(bundleRoot, file.absolutePath).split(path.sep).join("/"),
    size: file.size,
    sha256: file.sha256.replace(/^sha256:/, ""),
    absolutePath: file.absolutePath,
  }))).sort((left, right) => left.path.localeCompare(right.path));
  const tarballs = allFiles.filter((file) => file.path.toLowerCase().endsWith(".tgz"));
  if (tarballs.length === 0) throw new Error("candidate recovery for npm publication requires at least one exact .tgz payload artifact");
  const npmArtifacts = tarballs.map((file) => ({ file, metadata: readNpmPackageArtifact({ tarballPath: file.absolutePath, mainPackage: publishPackageMain }) }));
  const main = npmArtifacts.find((entry) => entry.metadata.role === "main") || (npmArtifacts.length === 1 ? npmArtifacts[0] : undefined);
  if (!main) throw new Error("candidate npm payload set has no unique main package tarball");
  const releaseMatchers = splitPatterns(releasePatterns).map(patternMatcher);
  const releaseAssets = allFiles.filter((file) => releaseMatchers.length
    ? releaseMatchers.some((matcher) => matcher.test(path.basename(file.path)))
    : file.path.toLowerCase().endsWith(".tgz"));
  const candidate = createRecoveredPublicationCandidate({
    allFiles,
    repository,
    passport,
    candidateRuntimeSha,
  });
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: main.metadata.name,
    packageVersion: main.metadata.ref,
    npmTarballPath: main.file.path,
    npmIntegrity: main.metadata.integrity,
    releaseAssetPaths: releaseAssets.map((file) => file.path),
  });
  return { manifest, npmArtifacts, allFiles };
}

async function recoverCandidateEvidence({
  repoInfo,
  runId,
  artifactName,
  artifactPatterns,
  requiredArtifactCount,
  outputDir,
  apiUrl,
  token,
  fetchImpl,
  archiveDir,
}) {
  const run = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}` });
  const workflow = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${run.workflow_id}` });
  const artifactResponse = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}/artifacts?per_page=100` });
  const artifacts = Array.isArray(artifactResponse.artifacts) ? artifactResponse.artifacts : [];
  if (Number(artifactResponse.total_count || artifacts.length) !== artifacts.length) throw new Error("candidate run has more than 100 artifacts; complete pagination is required before recovery");
  const selected = selectReleaseCandidateArtifacts({ artifacts, artifactName });
  const resolvedOutput = path.resolve(outputDir);
  const bundleRoot = path.join(resolvedOutput, "sealed-candidate");
  fs.mkdirSync(bundleRoot, { recursive: true });
  const initialDownloads = [];
  for (const artifact of [selected.passport, selected.summary]) initialDownloads.push(await downloadArtifact({ artifact, repoInfo, apiUrl, token, archiveDir, bundleRoot, fetchImpl }));
  const passport = readOnlyJson(initialDownloads[0].files.filter((file) => path.basename(file.path) === "release-candidate-passport.json"), "release-candidate-passport.json");
  const buildSummary = readOnlyJson(initialDownloads[1].files.filter((file) => path.basename(file.path) === "build-summary.json"), "build-summary.json");
  const requiredNames = candidateArtifactNames({ passport, selected, artifacts, artifactPatterns });
  const chosen = artifacts.filter((artifact) => requiredNames.has(artifact.name));
  if (chosen.length !== requiredNames.size) {
    const found = new Set(chosen.map((artifact) => artifact.name));
    throw new Error(`candidate artifacts are missing: ${[...requiredNames].filter((name) => !found.has(name)).join(", ")}`);
  }
  if (Number(requiredArtifactCount || 0) > 0 && chosen.length < Number(requiredArtifactCount)) throw new Error(`candidate artifact count ${chosen.length} is below required ${requiredArtifactCount}`);
  const downloads = [...initialDownloads];
  for (const artifact of chosen.filter((entry) => ![selected.passport.id, selected.summary.id].includes(entry.id))) downloads.push(await downloadArtifact({ artifact, repoInfo, apiUrl, token, archiveDir, bundleRoot, fetchImpl }));
  return {
    run, workflow, selected, resolvedOutput, bundleRoot, initialDownloads,
    passport, buildSummary, chosen, downloads,
  };
}

export async function resumeFromCandidateRun({
  repository,
  targetRepository = repository,
  candidateRunId,
  expectedWorkflowFile,
  expectedWorkflowName,
  channel,
  targetRef,
  targetSha,
  expectedSourceTree = "",
  expectedCandidateRoot = "",
  candidateRuntimeSha,
  runtimeSha,
  transactionId = "",
  artifactName = "",
  artifactPatterns = "",
  releasePatterns = "",
  requiredArtifactCount = 0,
  publishPackageMain = "",
  outputDir = ".buildchain/release-candidate-recovery",
  token = env("GITHUB_TOKEN"),
  apiUrl = env("GITHUB_API_URL", "https://api.github.com"),
  recoveryRunId = env("GITHUB_RUN_ID"),
  fetchImpl = globalThis.fetch,
} = {}) {
  const repoInfo = splitRepository(repository);
  const runId = String(candidateRunId || "").trim();
  if (!/^\d+$/.test(runId)) throw new Error("candidate run ID must be numeric");
  if (!String(expectedSourceTree || "").trim() && !String(expectedCandidateRoot || "").trim()) {
    throw new Error("candidate recovery requires expectedSourceTree or expectedCandidateRoot");
  }
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-resume-"));
  try {
    const {
      run, workflow, selected, resolvedOutput, bundleRoot, initialDownloads,
      passport, buildSummary, chosen, downloads,
    } = await recoverCandidateEvidence({
      repoInfo, runId, artifactName, artifactPatterns, requiredArtifactCount,
      outputDir, apiUrl, token, fetchImpl, archiveDir,
    });
    const prNumber = Number(passport.pullRequest?.number || 0);
    if (!prNumber) throw new Error("Release Candidate Passport has no PR identity");
    const pullRequest = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls/${prNumber}` });
    const targetCommit = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/commits/${targetSha}` });
    const targetRefState = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/ref/heads/${targetRef.replace(/^refs\/heads\//, "")}` });
    const observedTargetSha = String(targetRefState.object?.sha || "");
    const compare = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${pullRequest.merge_commit_sha}...${targetSha}` });
    const platformManifestEvidence = normalizePlatformManifests(downloads, passport);
    const controllerReceipts = normalizeControllerReceipts(downloads, passport);
    const productPayloadManifests = normalizeProductPayloadManifests(downloads);
    const sealed = createSealedBundle({
      downloads,
      bundleRoot,
      repository: repoInfo.fullName,
      passport,
      candidateRuntimeSha,
      publishPackageMain,
      releasePatterns,
    });
    const candidateVersion = sealed.manifest.npm.version;
    const existingTransaction = await readExistingTransaction({ repoInfo, apiUrl, token, fetchImpl, version: candidateVersion });
    let targetAdvance;
    if (observedTargetSha !== targetSha && transactionId && existingTransaction?.id === transactionId) {
      const targetAdvanceCompare = await githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${targetSha}...${observedTargetSha}`,
      });
      targetAdvance = {
        status: targetAdvanceCompare.status,
        mergeIsAncestor: ["ahead", "identical"].includes(targetAdvanceCompare.status),
      };
    }
    validateRecoveryTargetRef({
      targetSha,
      observedTargetSha,
      expectedTransactionId: transactionId,
      existingTransaction,
      ancestry: targetAdvance,
    });
    const recovery = verifyReleaseCandidateRecovery({
      candidateRepository: repoInfo.fullName,
      targetRepository,
      expectedRunId: runId,
      expectedWorkflowFile,
      expectedWorkflowName,
      channel,
      targetRef,
      targetSha,
      targetRefSha: observedTargetSha,
      targetTree: targetCommit.tree?.sha,
      expectedSourceTree,
      expectedCandidateRoot,
      expectedRuntimeSha: candidateRuntimeSha,
      expectedTransactionId: transactionId,
      existingTransaction,
      run: {
        id: String(run.id),
        repository: repoInfo.fullName,
        headRepository: run.head_repository?.full_name || "",
        status: run.status,
        conclusion: run.conclusion,
        event: run.event,
        path: run.path,
        name: run.name,
        headSha: run.head_sha || "",
        headBranch: run.head_branch || "",
        pullRequestNumbers: (run.pull_requests || []).map((entry) => Number(entry.number)),
      },
      workflow: { path: workflow.path, name: workflow.name, state: workflow.state },
      pullRequest: {
        number: pullRequest.number,
        merged: pullRequest.merged === true,
        mergeSha: pullRequest.merge_commit_sha,
        headRepository: pullRequest.head?.repo?.full_name || "",
        baseRef: pullRequest.base?.ref || "",
        authorAssociation: pullRequest.author_association || "",
        headSha: pullRequest.head?.sha || "",
        headRef: pullRequest.head?.ref || "",
      },
      ancestry: { status: compare.status, mergeIsAncestor: ["ahead", "identical"].includes(compare.status) },
      passport,
      buildSummary,
      controllerReceipts,
      platformManifests: platformManifestEvidence.manifests,
      platformManifestEvidence: platformManifestEvidence.evidence,
      productPayloadManifests,
      artifacts: downloads.map((download) => download.record),
      publicationVersion: candidateVersion,
      currentToolingSha: runtimeSha,
      recoveryRunId,
    });
    const recoveryReceiptPath = path.join(resolvedOutput, "recovery-receipt.json");
    const sealedManifestPath = path.join(resolvedOutput, "sealed-bundle.json");
    const requiredArtifactsPath = path.join(resolvedOutput, "publish-required-artifacts.json");
    fs.writeFileSync(recoveryReceiptPath, `${JSON.stringify(recovery.receipt, null, 2)}\n`);
    fs.writeFileSync(sealedManifestPath, `${JSON.stringify(sealed.manifest, null, 2)}\n`);
    const publishRequiredArtifacts = generatePublishRequiredArtifacts({
      kind: "npm",
      tarballPaths: sealed.npmArtifacts.map((entry) => entry.file.absolutePath),
      mainPackage: publishPackageMain,
    });
    fs.writeFileSync(requiredArtifactsPath, `${JSON.stringify(publishRequiredArtifacts, null, 2)}\n`);
    const tarballs = sealed.npmArtifacts.map((entry) => outputPath(entry.file.absolutePath));
    return {
      enabled: true,
      action: "reused",
      repository: repoInfo.fullName,
      run: { id: runId, url: run.html_url || "", name: run.name },
      artifacts: { passport: selected.passport.name, summary: selected.summary.name, payloads: chosen.map((artifact) => artifact.name), sourceSha: selected.sourceSha },
      version: candidateVersion,
      candidateRoot: recovery.receipt.recovered.candidateRoot,
      artifactRoot: recovery.receipt.recovered.artifactRoot,
      receipt: recovery.receipt,
      publishRequiredArtifacts,
      paths: {
        passport: outputPath(initialDownloads[0].files.find((file) => path.basename(file.path) === "release-candidate-passport.json").absolutePath),
        buildSummary: outputPath(initialDownloads[1].files.find((file) => path.basename(file.path) === "build-summary.json").absolutePath),
        payloads: outputPath(path.join(bundleRoot, "artifacts")),
        platformManifests: downloads.flatMap((download) => download.files.filter((file) => path.basename(file.path) === "manifest.json").map((file) => outputPath(file.absolutePath))),
        npmTarballs: tarballs,
        releaseAssets: sealed.manifest.releaseAssets.map((asset) => outputPath(path.join(bundleRoot, asset.path))),
        publishRequiredArtifacts: outputPath(requiredArtifactsPath),
        sealedBundleRoot: outputPath(bundleRoot),
        sealedBundleManifest: outputPath(sealedManifestPath),
        recoveryReceipt: outputPath(recoveryReceiptPath),
      },
    };
  } finally {
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
}

export async function resumeFromCandidateRunCli() {
  try {
    const result = await resumeFromCandidateRun({
      repository: requiredEnv("BUILDCHAIN_RESUME_CANDIDATE_REPOSITORY"),
      targetRepository: env("GITHUB_REPOSITORY"),
      candidateRunId: requiredEnv("BUILDCHAIN_RESUME_CANDIDATE_RUN_ID"),
      expectedWorkflowFile: requiredEnv("BUILDCHAIN_RESUME_EXPECTED_WORKFLOW_FILE"),
      expectedWorkflowName: requiredEnv("BUILDCHAIN_RESUME_EXPECTED_WORKFLOW_NAME"),
      channel: requiredEnv("BUILDCHAIN_RESUME_CHANNEL"),
      targetRef: requiredEnv("BUILDCHAIN_RESUME_TARGET_REF"),
      targetSha: requiredEnv("BUILDCHAIN_RESUME_TARGET_SHA"),
      expectedSourceTree: env("BUILDCHAIN_RESUME_EXPECTED_SOURCE_TREE"),
      expectedCandidateRoot: env("BUILDCHAIN_RESUME_EXPECTED_CANDIDATE_ROOT"),
      candidateRuntimeSha: requiredEnv("BUILDCHAIN_RESUME_EXPECTED_CANDIDATE_RUNTIME_SHA"),
      runtimeSha: requiredEnv("BUILDCHAIN_RESUME_RUNTIME_SHA"),
      transactionId: env("BUILDCHAIN_RESUME_TRANSACTION_ID"),
      artifactName: env("BUILDCHAIN_ARTIFACT_NAME"),
      artifactPatterns: env("BUILDCHAIN_ARTIFACT_PATTERNS"),
      releasePatterns: env("BUILDCHAIN_GITHUB_RELEASE_PAYLOAD_PATTERNS"),
      requiredArtifactCount: env("BUILDCHAIN_REQUIRED_ARTIFACT_COUNT", "0"),
      publishPackageMain: env("BUILDCHAIN_PUBLISH_PACKAGE_MAIN"),
      outputDir: env("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate-recovery"),
    });
    writeGitHubOutputs({
      "promote-only-release-candidate": "true",
      "release-candidate-action": result.action,
      "release-candidate-passport-path": result.paths.passport,
      "release-candidate-build-summary-path": result.paths.buildSummary,
      "release-candidate-version": result.version,
      "release-candidate-source-sha": result.artifacts.sourceSha,
      "release-candidate-artifact": result.artifacts.passport,
      "release-candidate-build-summary-artifact": result.artifacts.summary,
      "release-candidate-payload-artifacts": result.artifacts.payloads.join(","),
      "release-candidate-payload-dir": result.paths.payloads,
      "release-candidate-platform-manifest-paths": result.paths.platformManifests.join(","),
      "release-candidate-npm-tarball-paths": result.paths.npmTarballs.join(","),
      "release-candidate-github-release-artifact-paths": result.paths.releaseAssets.join("\n"),
      "publish-required-artifacts-json": JSON.stringify(result.publishRequiredArtifacts),
      "publish-required-artifacts-path": result.paths.publishRequiredArtifacts,
      "release-candidate-run-id": result.run.id,
      "release-candidate-run-url": result.run.url,
      "release-candidate-recovery-receipt-path": result.paths.recoveryReceipt,
      "release-candidate-recovery-root": result.receipt.root,
      "release-candidate-root": result.candidateRoot,
      "release-candidate-artifact-root": result.artifactRoot,
      "publish-sealed-bundle-root": result.paths.sealedBundleRoot,
      "publish-sealed-bundle-manifest": result.paths.sealedBundleManifest,
      "release-candidate-diagnosis": `Reused sealed candidate run ${result.run.id}; product build stages skipped`,
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const failure = recoveryFailure(error);
    writeGitHubOutputs({
      "release-candidate-action": "rejected",
      "release-candidate-recovery-error-code": failure.code,
      "release-candidate-recovery-next-action": failure.nextAction,
      "release-candidate-diagnosis": `${failure.code}: ${failure.reason}; next: ${failure.nextAction}`,
    });
    throw Object.assign(error, { recoveryFailure: failure });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resumeFromCandidateRunCli().catch((error) => {
    const failure = error.recoveryFailure || recoveryFailure(error);
    console.error(`candidate recovery rejected [${failure.code}]: ${failure.reason}`);
    console.error(`next action: ${failure.nextAction}`);
    process.exitCode = 1;
  });
}
