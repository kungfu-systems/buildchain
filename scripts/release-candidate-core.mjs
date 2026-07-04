import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_CANDIDATE_CONTRACT = "kungfu-buildchain-release-candidate";

function nowIso() {
  return new Date().toISOString();
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function requireString(value, label) {
  const normalized = optionalString(value).trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function requireSha(value, label) {
  const normalized = requireString(value, label);
  if (!/^[0-9a-f]{40}$/i.test(normalized)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return normalized;
}

function readJsonFile(filePath, label = filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} not found: ${filePath}`);
    }
    throw error;
  }
}

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function findJsonFiles(root) {
  const result = [];
  if (!root || !fs.existsSync(root)) {
    return result;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      result.push(fullPath);
    }
  }
  return result.sort();
}

export function loadReleaseCandidatePassport(filePath) {
  const passport = readJsonFile(filePath, "release candidate passport");
  if (passport.contract !== RELEASE_CANDIDATE_CONTRACT) {
    throw new Error(`release candidate passport contract mismatch: ${passport.contract || "<missing>"}`);
  }
  return passport;
}

function normalizePlatformManifest(filePath, cwd) {
  const manifest = readJsonFile(filePath, `platform manifest ${filePath}`);
  return {
    path: path.relative(cwd, filePath).split(path.sep).join("/"),
    sha256: sha256File(filePath),
    artifactName: optionalString(manifest.artifactName),
    platform: manifest.platform || {},
    summary: manifest.summary || {},
    expectedArtifacts: manifest.expectedArtifacts || {},
  };
}

function inferChannelFromRef(ref = "") {
  const normalized = optionalString(ref).replace(/^refs\/heads\//, "");
  if (normalized.startsWith("alpha/")) {
    return "alpha";
  }
  if (normalized.startsWith("release/")) {
    return "release";
  }
  if (normalized === "publish-gate/major" || normalized === "major-gate") {
    return "major";
  }
  return "";
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

export function createReleaseCandidatePassport({
  cwd = process.cwd(),
  outputDir = ".buildchain/release-candidate",
  buildSummaryPath = ".buildchain/artifacts/build-summary.json",
  platformManifestRoot = ".buildchain/downloaded-manifests",
  artifactName = "",
  builtSourceSha = "",
  builtSourceTreeSha = "",
  builtSourceRef = "",
  targetRef = "",
  publishGateRef = "",
  channel = "",
  version = "",
  repository = "",
  workflowRunId = "",
  workflowRunAttempt = "",
  pullRequestNumber = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedOutput = path.resolve(resolvedCwd, outputDir);
  const resolvedBuildSummary = path.resolve(resolvedCwd, buildSummaryPath);
  const buildSummary = readJsonFile(resolvedBuildSummary, "build summary");
  const manifestRoot = path.resolve(resolvedCwd, platformManifestRoot);
  const platformManifests = findJsonFiles(manifestRoot)
    .filter((filePath) => path.basename(filePath) === "manifest.json")
    .map((filePath) => normalizePlatformManifest(filePath, resolvedCwd));
  if (platformManifests.length === 0) {
    throw new Error(`release candidate requires at least one platform manifest under ${manifestRoot}`);
  }
  const builtSha = requireSha(builtSourceSha || buildSummary.git?.sha, "built-source-sha");
  const builtTree = requireSha(builtSourceTreeSha, "built-source-tree-sha");
  const resolvedTargetRef = requireString(targetRef || buildSummary.publishSource?.ref || buildSummary.git?.ref, "target-ref");
  const resolvedChannel = channel || buildSummary.publishGate?.channel || buildSummary.publishSource?.channel || inferChannelFromRef(resolvedTargetRef);
  const resolvedVersion = version || buildSummary.publishSource?.consumerVersion || inferVersionFromReleaseManifest(buildSummary);
  const passport = {
    schema: 1,
    contract: RELEASE_CANDIDATE_CONTRACT,
    generatedAt: nowIso(),
    repository: repository || buildSummary.git?.repository || "",
    releaseIntent: {
      channel: resolvedChannel,
      version: resolvedVersion,
      targetRef: resolvedTargetRef,
      publishGateRef: publishGateRef || "",
    },
    source: {
      builtSourceSha: builtSha,
      builtSourceTreeSha: builtTree,
      builtSourceRef: builtSourceRef || buildSummary.git?.ref || "",
      pullRequestNumber: optionalString(pullRequestNumber),
    },
    build: {
      artifactName: artifactName || buildSummary.artifactName || "",
      workflowRunId: optionalString(workflowRunId || buildSummary.git?.runId),
      workflowRunAttempt: optionalString(workflowRunAttempt || buildSummary.git?.runAttempt),
      summaryPath: "build-summary.json",
      summarySha256: sha256File(resolvedBuildSummary),
      platformCount: platformManifests.length,
      fileCount: Number(buildSummary.fileCount || 0),
      totalBytes: Number(buildSummary.totalBytes || 0),
    },
    platformManifests,
  };
  fs.mkdirSync(resolvedOutput, { recursive: true });
  fs.copyFileSync(resolvedBuildSummary, path.join(resolvedOutput, "build-summary.json"));
  for (const manifest of platformManifests) {
    const target = path.join(
      resolvedOutput,
      "platform-manifests",
      manifest.platform?.id || manifest.artifactName || path.basename(path.dirname(manifest.path)),
      "manifest.json",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(resolvedCwd, manifest.path), target);
  }
  const passportPath = path.join(resolvedOutput, "release-candidate.passport.json");
  fs.writeFileSync(passportPath, `${JSON.stringify(passport, null, 2)}\n`);
  return { passport, passportPath, outputDir: resolvedOutput };
}

export function validateReleaseCandidateForPromotion({
  passport,
  buildSummary,
  promotionChannelSha = "",
  promotionChannelTreeSha = "",
  targetRef = "",
  publishGateRef = "",
  publishGateSha = "",
  expectedVersion = "",
  requiredArtifactCount = 0,
} = {}) {
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    throw new Error("release candidate passport is required");
  }
  if (passport.contract !== RELEASE_CANDIDATE_CONTRACT) {
    throw new Error(`release candidate passport contract mismatch: ${passport.contract || "<missing>"}`);
  }
  if (!buildSummary || typeof buildSummary !== "object" || Array.isArray(buildSummary)) {
    throw new Error("release candidate build summary is required");
  }
  const builtSourceSha = requireSha(passport.source?.builtSourceSha, "built-source-sha");
  const builtSourceTreeSha = requireSha(passport.source?.builtSourceTreeSha, "built-source-tree-sha");
  const channelSha = requireSha(promotionChannelSha, "promotion-channel-sha");
  const channelTreeSha = requireSha(promotionChannelTreeSha, "promotion-channel-tree-sha");
  if (buildSummary.git?.sha && buildSummary.git.sha !== builtSourceSha) {
    throw new Error(`release candidate build summary source mismatch: ${buildSummary.git.sha} != ${builtSourceSha}`);
  }
  if (builtSourceTreeSha !== channelTreeSha) {
    throw new Error(
      `release candidate tree mismatch: built-source-sha ${builtSourceSha} tree ${builtSourceTreeSha} does not match promotion-channel-sha ${channelSha} tree ${channelTreeSha}`,
    );
  }
  const resolvedTargetRef = targetRef || passport.releaseIntent?.targetRef || "";
  if (targetRef && passport.releaseIntent?.targetRef && targetRef !== passport.releaseIntent.targetRef) {
    throw new Error(`release candidate target ref mismatch: ${passport.releaseIntent.targetRef} != ${targetRef}`);
  }
  if (expectedVersion && passport.releaseIntent?.version && passport.releaseIntent.version !== expectedVersion) {
    throw new Error(`release candidate version mismatch: ${passport.releaseIntent.version} != ${expectedVersion}`);
  }
  if (publishGateRef && passport.releaseIntent?.publishGateRef && passport.releaseIntent.publishGateRef !== publishGateRef) {
    throw new Error(`release candidate publish-gate ref mismatch: ${passport.releaseIntent.publishGateRef} != ${publishGateRef}`);
  }
  if (publishGateSha && publishGateSha !== channelSha) {
    throw new Error(`publish-gate ref must point at promotion-channel-sha ${channelSha}; got ${publishGateSha}`);
  }
  const platformCount = Number(passport.build?.platformCount || 0);
  if (requiredArtifactCount > 0 && platformCount < requiredArtifactCount) {
    throw new Error(`release candidate artifact count ${platformCount} is below required ${requiredArtifactCount}`);
  }
  if (!Array.isArray(passport.platformManifests) || passport.platformManifests.length !== platformCount) {
    throw new Error("release candidate platform manifest count is inconsistent");
  }
  return {
    ok: true,
    builtSourceSha,
    builtSourceTreeSha,
    promotionChannelSha: channelSha,
    promotionChannelTreeSha: channelTreeSha,
    targetRef: resolvedTargetRef,
    publishGateRef: publishGateRef || passport.releaseIntent?.publishGateRef || "",
    treeEquivalent: true,
    platformCount,
  };
}

export function readReleaseCandidateBundle({
  passportPath,
  buildSummaryPath = "",
} = {}) {
  const passport = loadReleaseCandidatePassport(passportPath);
  const resolvedSummary = buildSummaryPath || path.join(path.dirname(passportPath), passport.build?.summaryPath || "build-summary.json");
  const buildSummary = readJsonFile(resolvedSummary, "release candidate build summary");
  return { passport, buildSummary, buildSummaryPath: resolvedSummary };
}
