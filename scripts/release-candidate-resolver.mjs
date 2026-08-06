#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createResolvedPublicationSealedBundle } from "./publication-candidate-sealer.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const DEFAULT_WORKFLOW_FILE = "build-surface-fixture.yml";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

export function releaseCandidateDownloadEnabled(value = "true") {
  return String(value || "true").trim().toLowerCase() !== "false";
}

function splitRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`repository must be owner/repo, got ${repository || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function normalizeBranch(value = "") {
  return String(value || "").replace(/^refs\/heads\//, "").trim();
}

function assertSha(value, label = "sha") {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha;
}

function githubHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "buildchain-release-candidate-resolver",
    "x-github-api-version": "2022-11-28",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function githubJson({ apiUrl, token, method = "GET", path: requestPath, fetchImpl = globalThis.fetch, allowNotFound = false }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to resolve release candidate artifacts");
  }
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { method, headers: githubHeaders(token) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${requestPath} failed with ${response.status}: ${body.message || text}`);
  }
  return body;
}

export async function githubDownload({ apiUrl, token, path: requestPath, outputPath, fetchImpl = globalThis.fetch }) {
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`GitHub artifact download ${requestPath} failed with ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  try {
    if (response.body && typeof response.body.getReader === "function") {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));
    } else {
      fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
    }
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
  return outputPath;
}

function digestFileSync(filePath, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest(encoding);
}

export function selectMergedChannelPullRequest({ pullRequests = [], targetRef, repository }) {
  const normalizedTarget = normalizeBranch(targetRef);
  const candidates = pullRequests.filter((pr) => {
    const baseRef = normalizeBranch(pr.base?.ref || pr.baseRefName || "");
    const merged = Boolean(pr.merged_at || pr.mergedAt || pr.state === "closed");
    const sameRepo = !repository || !pr.head?.repo?.full_name || pr.head.repo.full_name === repository;
    return merged && sameRepo && baseRef === normalizedTarget;
  });
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.merged_at || left.updated_at || left.closed_at || "");
    const rightTime = Date.parse(right.merged_at || right.updated_at || right.closed_at || "");
    return (rightTime || 0) - (leftTime || 0);
  });
  return candidates[0];
}

export function selectReleaseCandidateRuns({ runs = [], pullRequest, workflowName = "" }) {
  const prNumber = Number(pullRequest?.number || 0);
  const prHeadSha = String(pullRequest?.head?.sha || pullRequest?.headRefOid || "").trim();
  const prHeadBranch = normalizeBranch(pullRequest?.head?.ref || pullRequest?.headRefName || "");
  const prHeadRepository = pullRequest?.head?.repo?.full_name || pullRequest?.headRepository?.nameWithOwner || "";
  const candidates = runs.filter((run) => {
    const runPrs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const runHeadBranch = normalizeBranch(run.head_branch || "");
    const runHeadSha = String(run.head_sha || "").trim();
    const runHeadRepository = run.head_repository?.full_name || run.headRepository?.nameWithOwner || "";
    const matchesPrNumber = runPrs.some((pr) => Number(pr.number || 0) === prNumber);
    const matchesHeadSha = prHeadSha && runHeadSha === prHeadSha;
    const matchesHeadBranch = prHeadBranch
      && runHeadBranch === prHeadBranch
      && (!prHeadRepository || !runHeadRepository || runHeadRepository === prHeadRepository);
    const matchesPr = matchesPrNumber || matchesHeadSha || (!prNumber && !prHeadSha && matchesHeadBranch);
    const matchesWorkflow = !workflowName || run.name === workflowName || run.workflow_name === workflowName;
    return matchesPr && matchesWorkflow && run.event === "pull_request" && run.status === "completed" && run.conclusion === "success";
  });
  candidates.sort((left, right) => Date.parse(right.updated_at || right.created_at || "") - Date.parse(left.updated_at || left.created_at || ""));
  return candidates;
}

export function selectReleaseCandidateRun({ runs = [], pullRequest, workflowName = "" }) {
  return selectReleaseCandidateRuns({ runs, pullRequest, workflowName })[0];
}

function outputPath(filePath) {
  const relative = path.relative(process.cwd(), filePath).split(path.sep).join("/");
  return relative.startsWith("../") || relative === ".." ? filePath : relative;
}

function splitPatterns(value = "") {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artifactPatternToRegExp(pattern) {
  return new RegExp(`^${String(pattern).split("*").map(escapeRegExp).join(".*")}$`);
}

export function selectPayloadArtifacts({
  artifacts = [],
  artifactName = "",
  sourceSha = "",
  patterns = [],
} = {}) {
  const prefix = String(artifactName || "").trim();
  const sha = assertSha(sourceSha, "sourceSha");
  const active = artifacts.filter((artifact) => !artifact.expired);
  const excludedNames = new Set([
    `${prefix}-release-candidate-${sha}`,
    `${prefix}-summary-${sha}`,
    `${prefix}-diagnostics-summary-${sha}`,
  ]);
  const effectivePatterns = splitPatterns(patterns).length
    ? splitPatterns(patterns)
    : [`${prefix}-manifest-*-${sha}`];
  const matchers = effectivePatterns.map(artifactPatternToRegExp);
  return active
    .filter((artifact) => !excludedNames.has(String(artifact.name || "")))
    .filter((artifact) => matchers.some((matcher) => matcher.test(String(artifact.name || ""))))
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
}

function findDownloadedFiles(root, filename) {
  const matches = [];
  const stack = fs.existsSync(root) ? [root] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === filename) {
        matches.push(fullPath);
      }
    }
  }
  return matches.sort();
}

function findDownloadedFilesByExtension(root, extensions = []) {
  const normalizedExtensions = extensions.map((extension) => String(extension || "").toLowerCase());
  const matches = [];
  const stack = fs.existsSync(root) ? [root] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      if (normalizedExtensions.some((extension) => lowerName.endsWith(extension))) {
        matches.push(fullPath);
      }
    }
  }
  return matches.sort();
}

export function selectReleaseAssetPaths({
  payloadRoot,
  patterns = [],
} = {}) {
  const matchers = splitPatterns(patterns).map(artifactPatternToRegExp);
  if (matchers.length === 0) return [];
  const files = [];
  const stack = fs.existsSync(payloadRoot) ? [payloadRoot] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        matchers.some((matcher) => matcher.test(entry.name))
      ) {
        files.push(fullPath);
      }
    }
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(
      `release candidate payload patterns matched no files: ${splitPatterns(patterns).join(", ")}`,
    );
  }
  const basenames = new Set();
  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (basenames.has(basename)) {
      throw new Error(
        `release candidate public asset basename is not unique: ${basename}`,
      );
    }
    basenames.add(basename);
  }
  return files;
}

function packageNameFromArtifactPath(filePath) {
  const basename = path.basename(String(filePath || ""));
  return basename
    .replace(/\.tgz$/i, "")
    .replace(/\.tar\.gz$/i, "")
    .replace(/\.zip$/i, "");
}

function npmIntegrity(filePath) {
  return `sha512-${digestFileSync(filePath, "sha512", "base64")}`;
}

function readNpmPackageJsonFromTarball(tarballPath) {
  const candidates = ["package/package.json", "./package/package.json"];
  const errors = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(execFileSync("tar", ["-xOf", tarballPath, candidate], { encoding: "utf8" }));
    } catch (error) {
      errors.push(error.stderr?.toString?.().trim() || error.message);
    }
  }
  throw new Error(`npm package tarball ${tarballPath} does not contain package/package.json: ${errors.filter(Boolean).join("; ")}`);
}

export function readNpmPackageArtifact({
  tarballPath,
  mainPackage = "",
  kind = "npm",
} = {}) {
  const packageJson = readNpmPackageJsonFromTarball(tarballPath);
  const name = String(packageJson.name || "").trim();
  const version = String(packageJson.version || "").trim();
  if (!name || !version) {
    throw new Error(`npm package tarball ${tarballPath || "<empty>"} package.json must include name and version`);
  }
  const integrity = npmIntegrity(tarballPath);
  return {
    kind,
    name,
    ref: version,
    digest: integrity,
    integrity,
    role: mainPackage && name === mainPackage ? "main" : "platform",
  };
}

export function generatePublishRequiredArtifacts({
  manifests = [],
  version = "",
  kind = "npm",
  tarballPaths = [],
  mainPackage = "",
} = {}) {
  if (String(kind || "") === "npm" && tarballPaths.length > 0) {
    const artifacts = tarballPaths
      .map((tarballPath) => readNpmPackageArtifact({ tarballPath, mainPackage, kind }))
      .sort((left, right) => `${left.role}:${left.name}`.localeCompare(`${right.role}:${right.name}`));
    const seen = new Set();
    for (const artifact of artifacts) {
      const key = `${artifact.name}@${artifact.ref}`;
      if (seen.has(key)) {
        throw new Error(`duplicate npm package tarball for ${key}`);
      }
      seen.add(key);
    }
    return artifacts;
  }
  const ref = String(version || "").trim();
  if (!ref) {
    return [];
  }
  return manifests.flatMap((manifest) => {
    const platform = manifest.platform?.id || manifest.platformId || "";
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    return files
      .filter((file) => file?.sha256)
      .map((file) => ({
        kind,
        name: packageNameFromArtifactPath(file.path || file.name || manifest.artifactName || platform),
        ref,
        digest: String(file.sha256).startsWith("sha256:")
          ? String(file.sha256)
          : `sha256:${file.sha256}`,
        role: "platform",
        platform,
      }));
  });
}

export function selectReleaseCandidateArtifacts({ artifacts = [], artifactName = "" }) {
  const expectedPrefix = String(artifactName || "").trim();
  const active = artifacts.filter((artifact) => !artifact.expired);
  const passports = active
    .map((artifact) => {
      const match = String(artifact.name || "").match(/^(.+)-release-candidate-([0-9a-f]{40})$/i);
      return match ? { artifact, prefix: match[1], sourceSha: match[2] } : undefined;
    })
    .filter(Boolean)
    .filter((candidate) => !expectedPrefix || candidate.prefix === expectedPrefix);
  if (passports.length !== 1) {
    const scope = expectedPrefix ? ` for artifact-name ${expectedPrefix}` : "";
    throw new Error(`expected exactly one release-candidate passport artifact${scope}, found ${passports.length}`);
  }
  const { artifact: passport, prefix, sourceSha: sha } = passports[0];
  const summaries = active.filter((artifact) => artifact.name === `${prefix}-summary-${sha}`);
  if (summaries.length !== 1) {
    throw new Error(`expected exactly one build summary artifact named ${prefix}-summary-${sha}, found ${summaries.length}`);
  }
  return { passport, summary: summaries[0], prefix, sourceSha: sha };
}

export function verifyArtifactArchive({ artifact, archivePath } = {}) {
  const size = fs.statSync(archivePath).size;
  const digest = `sha256:${digestFileSync(archivePath, "sha256", "hex")}`;
  if (!artifact || artifact.expired === true) {
    throw new Error(`candidate artifact is missing or expired: ${artifact?.name || "<unknown>"}`);
  }
  if (Number(artifact.size_in_bytes) !== size) {
    throw new Error(`candidate artifact size mismatch for ${artifact.name}: expected ${artifact.size_in_bytes}, got ${size}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(artifact.digest || ""))) {
    throw new Error(`candidate artifact ${artifact.name} has no trusted sha256 digest metadata`);
  }
  if (String(artifact.digest).toLowerCase() !== digest) {
    throw new Error(`candidate artifact digest mismatch for ${artifact.name}: expected ${artifact.digest}, got ${digest}`);
  }
  return { size, digest };
}

export function unzip(zipPath, outputDir) {
  const entries = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
      throw new Error(`candidate artifact contains an unsafe zip entry: ${entry}`);
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", outputDir], { stdio: "inherit" });
}

function findDownloadedFile(root, filename) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
  }
  return "";
}

export async function resolveReleaseCandidateArtifacts({
  repository,
  targetRef,
  targetSha,
  token = env("GITHUB_TOKEN"),
  apiUrl = env("GITHUB_API_URL", "https://api.github.com"),
  workflowFile = DEFAULT_WORKFLOW_FILE,
  workflowName = "Build Surface Fixture",
  artifactName = "",
  artifactPatterns = "",
  githubReleasePayloadPatterns = "",
  requiredArtifactCount = 0,
  publishArtifactKind = "npm",
  publishPackageMain = "",
  runtimeSha = "",
  outputDir = ".buildchain/release-candidate",
  fetchImpl = globalThis.fetch,
  download = true,
  waitSeconds = 600,
  pollIntervalMs = 15000,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const repoInfo = splitRepository(repository);
  const sha = assertSha(targetSha, "targetSha");
  const normalizedTarget = normalizeBranch(targetRef);
  const releaseCandidateTarget = /^(alpha|release)\/v\d+\/v\d+\.\d+$/.test(normalizedTarget);
  const majorGateTarget = normalizedTarget === "publish-gate/major" || normalizedTarget === "major-gate";
  if (!releaseCandidateTarget && !majorGateTarget) {
    return {
      enabled: false,
      reason: `target ref ${normalizedTarget || "(empty)"} does not require release-candidate promotion`,
    };
  }
  const pulls = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${sha}/pulls`,
  });
  const channelPullRequest = selectMergedChannelPullRequest({
    pullRequests: Array.isArray(pulls) ? pulls : [],
    targetRef: normalizedTarget,
    repository: repoInfo.fullName,
  });
  if (!channelPullRequest) {
    throw new Error(`no same-repository merged channel PR found for ${sha} into ${normalizedTarget}`);
  }
  let pullRequest = channelPullRequest;
  if (majorGateTarget) {
    const releaseRef = normalizeBranch(channelPullRequest.head?.ref || "");
    if (!/^release\/v\d+\/v\d+\.\d+$/.test(releaseRef)) {
      throw new Error(
        `major gate ${normalizedTarget} must be merged from a release/vN/vN.M head, got ${releaseRef || "<empty>"}`,
      );
    }
    const releaseSha = assertSha(channelPullRequest.head?.sha, "major gate release head SHA");
    const releasePulls = await githubJson({
      apiUrl,
      token,
      fetchImpl,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${releaseSha}/pulls`,
    });
    pullRequest = selectMergedChannelPullRequest({
      pullRequests: Array.isArray(releasePulls) ? releasePulls : [],
      targetRef: releaseRef,
      repository: repoInfo.fullName,
    });
    if (!pullRequest) {
      throw new Error(
        `no same-repository merged release-candidate PR found for major gate release head ${releaseSha} into ${releaseRef}`,
      );
    }
    const releaseMergeSha = assertSha(
      pullRequest.merge_commit_sha || pullRequest.mergeCommit?.oid,
      "release-candidate PR merge SHA",
    );
    if (releaseMergeSha !== releaseSha) {
      throw new Error(
        `major gate release head ${releaseSha} does not equal release-candidate PR #${pullRequest.number} merge ${releaseMergeSha}`,
      );
    }
  }
  const timeoutMs = Number(waitSeconds) * 1000;
  const intervalMs = Number(pollIntervalMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`release-candidate waitSeconds must be a non-negative number, got ${waitSeconds}`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`release-candidate pollIntervalMs must be a non-negative number, got ${pollIntervalMs}`);
  }
  const deadline = Date.now() + timeoutMs;
  let run;
  let artifactResponse;
  let selected;
  let selectionErrors = [];
  let candidateRuns = [];
  while (!selected) {
    const runs = await githubJson({
      apiUrl,
      token,
      fetchImpl,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=pull_request&status=success&per_page=100`,
    });
    candidateRuns = selectReleaseCandidateRuns({
      runs: Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [],
      pullRequest,
      workflowName,
    });
    selectionErrors = [];
    for (const candidateRun of candidateRuns) {
      const candidateArtifactResponse = await githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${candidateRun.id}/artifacts?per_page=100`,
      });
      try {
        selected = selectReleaseCandidateArtifacts({
          artifacts: Array.isArray(candidateArtifactResponse.artifacts) ? candidateArtifactResponse.artifacts : [],
          artifactName,
        });
        run = candidateRun;
        artifactResponse = candidateArtifactResponse;
        break;
      } catch (error) {
        selectionErrors.push(`run ${candidateRun.id}: ${error.message}`);
      }
    }
    if (selected) break;
    if (Date.now() >= deadline) {
      if (!candidateRuns.length) {
        throw new Error(`no successful ${workflowName} pull_request run found for channel PR #${pullRequest.number} within ${waitSeconds}s`);
      }
      throw new Error(`no successful ${workflowName} pull_request run for channel PR #${pullRequest.number} contained release-candidate artifacts within ${waitSeconds}s: ${selectionErrors.join("; ")}`);
    }
    console.log(
      `> waiting for successful ${workflowName} release-candidate evidence for channel PR #${pullRequest.number}`,
    );
    await sleepImpl(intervalMs);
  }
  const payloadArtifacts = selectPayloadArtifacts({
    artifacts: Array.isArray(artifactResponse.artifacts) ? artifactResponse.artifacts : [],
    artifactName: selected.prefix,
    sourceSha: selected.sourceSha,
    patterns: artifactPatterns,
  });
  const minimumPayloadCount = Number(requiredArtifactCount || 0);
  if (minimumPayloadCount > 0 && payloadArtifacts.length < minimumPayloadCount) {
    throw new Error(`expected at least ${minimumPayloadCount} PR-stage payload artifacts, found ${payloadArtifacts.length}`);
  }
  const result = {
    enabled: true,
    repository: repoInfo.fullName,
    targetRef: normalizedTarget,
    targetSha: sha,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url || pullRequest.url || "",
      headRef: pullRequest.head?.ref || "",
      baseRef: pullRequest.base?.ref || "",
    },
    ...(majorGateTarget
      ? {
          promotionPullRequest: {
            number: channelPullRequest.number,
            url: channelPullRequest.html_url || channelPullRequest.url || "",
            headRef: channelPullRequest.head?.ref || "",
            baseRef: channelPullRequest.base?.ref || "",
          },
        }
      : {}),
    run: {
      id: String(run.id || ""),
      url: run.html_url || run.url || "",
      name: run.name || workflowName,
    },
    artifacts: {
      passport: selected.passport.name,
      summary: selected.summary.name,
      payloads: payloadArtifacts.map((artifact) => artifact.name),
      artifactName: selected.prefix,
      sourceSha: selected.sourceSha,
    },
  };
  if (!download) {
    return result;
  }
  const resolvedOutput = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rc-"));
  const passportDir = path.join(resolvedOutput, "passport");
  const summaryDir = path.join(resolvedOutput, "summary");
  const payloadDir = path.join(resolvedOutput, "payloads");
  const passportZip = path.join(tempDir, "passport.zip");
  const summaryZip = path.join(tempDir, "summary.zip");
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: passportZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.passport.id}/zip`,
  });
  verifyArtifactArchive({ artifact: selected.passport, archivePath: passportZip });
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: summaryZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.summary.id}/zip`,
  });
  verifyArtifactArchive({ artifact: selected.summary, archivePath: summaryZip });
  for (const artifact of payloadArtifacts) {
    const safeName = String(artifact.name || `artifact-${artifact.id}`).replace(/[^A-Za-z0-9._-]/g, "_");
    const payloadZip = path.join(tempDir, `${safeName}.zip`);
    await githubDownload({
      apiUrl,
      token,
      fetchImpl,
      outputPath: payloadZip,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${artifact.id}/zip`,
    });
    verifyArtifactArchive({ artifact, archivePath: payloadZip });
    unzip(payloadZip, path.join(payloadDir, safeName));
  }
  unzip(passportZip, passportDir);
  unzip(summaryZip, summaryDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
  const passportPath = findDownloadedFile(passportDir, "release-candidate-passport.json");
  const buildSummaryPath = findDownloadedFile(summaryDir, "build-summary.json");
  if (!passportPath || !buildSummaryPath) {
    throw new Error("downloaded release-candidate artifacts did not contain release-candidate-passport.json and build-summary.json");
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const platformManifestPaths = findDownloadedFiles(payloadDir, "manifest.json");
  const githubArtifactAttestationPolicyPaths = findDownloadedFiles(
    payloadDir,
    "github-artifact-attestation-policy.json",
  );
  const npmTarballPaths = publishArtifactKind === "npm"
    ? findDownloadedFilesByExtension(payloadDir, [".tgz"])
    : [];
  const releaseAssetPaths = selectReleaseAssetPaths({
    payloadRoot: payloadDir,
    patterns: githubReleasePayloadPatterns,
  });
  const downloadedRequiredArtifactCount = publishArtifactKind === "npm"
    ? npmTarballPaths.length
    : platformManifestPaths.length;
  if (minimumPayloadCount > 0 && downloadedRequiredArtifactCount < minimumPayloadCount) {
    const noun = publishArtifactKind === "npm" ? "npm package tarballs" : "platform manifests";
    throw new Error(`expected at least ${minimumPayloadCount} downloaded ${noun}, found ${downloadedRequiredArtifactCount}`);
  }
  const manifests = platformManifestPaths.map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  const generatedRequiredArtifacts = generatePublishRequiredArtifacts({
    manifests,
    version: passport.target?.version || "",
    kind: publishArtifactKind,
    tarballPaths: npmTarballPaths,
    mainPackage: publishPackageMain,
  });
  const requiredArtifactsPath = path.join(resolvedOutput, "publish-required-artifacts.json");
  fs.writeFileSync(requiredArtifactsPath, `${JSON.stringify(generatedRequiredArtifacts, null, 2)}\n`);
  const sealedBundle = publishArtifactKind === "npm"
    ? createResolvedPublicationSealedBundle({
        bundleRoot: payloadDir,
        repository: repoInfo.fullName,
        sourceSha: passport.source?.headSha,
        sourceTreeSha: passport.source?.treeHash,
        runtimeSha: runtimeSha || sha,
        releaseCandidateRoot: passport.candidateHash,
        npmArtifacts: npmTarballPaths.map((tarballPath) => ({
          path: tarballPath,
          ...readNpmPackageArtifact({ tarballPath, mainPackage: publishPackageMain }),
        })),
        releaseAssetPaths,
      })
    : undefined;
  const sealedBundleManifestPath = sealedBundle
    ? path.join(resolvedOutput, "sealed-bundle.json")
    : "";
  if (sealedBundleManifestPath) {
    fs.writeFileSync(sealedBundleManifestPath, `${JSON.stringify(sealedBundle.manifest, null, 2)}\n`);
  }
  return {
    ...result,
    paths: {
      passport: outputPath(passportPath),
      buildSummary: outputPath(buildSummaryPath),
      payloads: outputPath(payloadDir),
      platformManifests: platformManifestPaths.map(outputPath),
      githubArtifactAttestationPolicies: githubArtifactAttestationPolicyPaths.map(outputPath),
      npmTarballs: npmTarballPaths.map(outputPath),
      releaseAssets: releaseAssetPaths.map(outputPath),
      publishRequiredArtifacts: outputPath(requiredArtifactsPath),
      sealedBundleRoot: sealedBundle ? outputPath(sealedBundle.root) : "",
      sealedBundleManifest: sealedBundleManifestPath ? outputPath(sealedBundleManifestPath) : "",
    },
    version: passport.target?.version || "",
    candidateHash: passport.candidateHash || "",
    payloadCount: payloadArtifacts.length,
    platformManifestCount: platformManifestPaths.length,
    githubArtifactAttestationPolicyCount: githubArtifactAttestationPolicyPaths.length,
    npmTarballCount: npmTarballPaths.length,
    publishRequiredArtifacts: generatedRequiredArtifacts,
  };
}

export async function resolveReleaseCandidateArtifactsCli() {
  const result = await resolveReleaseCandidateArtifacts({
    repository: env("BUILDCHAIN_SOURCE_REPOSITORY", env("GITHUB_REPOSITORY")),
    targetRef: env("BUILDCHAIN_TARGET_REF"),
    targetSha: env("BUILDCHAIN_TARGET_SHA"),
    workflowFile: env("BUILDCHAIN_RC_WORKFLOW_FILE", DEFAULT_WORKFLOW_FILE),
    workflowName: env("BUILDCHAIN_RC_WORKFLOW_NAME", ""),
    artifactName: env("BUILDCHAIN_ARTIFACT_NAME"),
    artifactPatterns: env("BUILDCHAIN_ARTIFACT_PATTERNS"),
    githubReleasePayloadPatterns: env(
      "BUILDCHAIN_GITHUB_RELEASE_PAYLOAD_PATTERNS",
    ),
    requiredArtifactCount: env("BUILDCHAIN_REQUIRED_ARTIFACT_COUNT", "0"),
    publishArtifactKind: env("BUILDCHAIN_PUBLISH_ARTIFACT_KIND", "npm"),
    publishPackageMain: env("BUILDCHAIN_PUBLISH_PACKAGE_MAIN"),
    runtimeSha: env("BUILDCHAIN_CURRENT_RUNTIME_SHA", env("BUILDCHAIN_RUNTIME_SHA", env("BUILDCHAIN_TARGET_SHA"))),
    outputDir: env("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate"),
    download: releaseCandidateDownloadEnabled(env("BUILDCHAIN_RC_DOWNLOAD", "true")),
    waitSeconds: env("BUILDCHAIN_RC_WAIT_SECONDS", "600"),
    pollIntervalMs: env("BUILDCHAIN_RC_POLL_INTERVAL_MS", "15000"),
  });
  writeGitHubOutputs({
    "promote-only-release-candidate": String(result.enabled === true),
    "release-candidate-passport-path": result.paths?.passport || "",
    "release-candidate-build-summary-path": result.paths?.buildSummary || "",
    "release-candidate-version": result.version || "",
    "release-candidate-source-sha": result.artifacts?.sourceSha || "",
    "release-candidate-artifact": result.artifacts?.passport || "",
    "release-candidate-build-summary-artifact": result.artifacts?.summary || "",
    "release-candidate-payload-artifacts": (result.artifacts?.payloads || []).join(","),
    "release-candidate-payload-dir": result.paths?.payloads || "",
    "release-candidate-platform-manifest-paths": (result.paths?.platformManifests || []).join(","),
    "release-candidate-platform-manifest-count": String(result.platformManifestCount || 0),
    "release-candidate-github-artifact-attestation-policy-paths": (
      result.paths?.githubArtifactAttestationPolicies || []
    ).join(","),
    "release-candidate-github-artifact-attestation-policy-count": String(
      result.githubArtifactAttestationPolicyCount || 0,
    ),
    "release-candidate-npm-tarball-paths": (result.paths?.npmTarballs || []).join(","),
    "release-candidate-npm-tarball-count": String(result.npmTarballCount || 0),
    "release-candidate-github-release-artifact-paths": (
      result.paths?.releaseAssets || []
    ).join("\n"),
    "publish-required-artifacts-json": JSON.stringify(result.publishRequiredArtifacts || []),
    "publish-required-artifacts-path": result.paths?.publishRequiredArtifacts || "",
    "publish-sealed-bundle-root": result.paths?.sealedBundleRoot || "",
    "publish-sealed-bundle-manifest": result.paths?.sealedBundleManifest || "",
    "release-candidate-run-id": result.run?.id || "",
    "release-candidate-run-url": result.run?.url || "",
    "release-candidate-pr": result.pullRequest?.number ? String(result.pullRequest.number) : "",
    "release-candidate-diagnosis": result.enabled
      ? `Resolved PR-stage RC passport ${result.artifacts.passport} from ${result.run.url || `run ${result.run.id}`}`
      : result.reason || "",
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await resolveReleaseCandidateArtifactsCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
