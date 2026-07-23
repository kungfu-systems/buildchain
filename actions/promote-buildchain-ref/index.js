import * as core from "@actions/core";
import * as github from "@actions/github";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseTags, promoteBuildchainRefs } from "./lib.js";
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../../packages/core/release-line-dry-run.js";
import { ensureGitHubRelease } from "../../scripts/ensure-github-release.mjs";

function normalizePublishSourceRef(ref = "") {
  return String(ref || "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function parseLockedPublishSource(ref = "") {
  const sourceRef = normalizePublishSourceRef(ref);
  if (sourceRef === "publish-gate/major") {
    return { sourceRef, channel: "major", line: "", consumerVersion: "" };
  }
  const match = sourceRef.match(/^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/);
  if (!match) {
    return { sourceRef, channel: "", line: "", consumerVersion: "" };
  }
  return {
    sourceRef,
    channel: match[1],
    line: match[2],
    consumerVersion: match[3],
  };
}

function checkSourceLock(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

export function validateRequiredPublishSourceLock({
  sha,
  publishSourceRef = "",
  publishSourceSha = "",
  publishSourceLocked = "",
} = {}) {
  if (publishSourceSha && publishSourceSha !== sha) {
    throw new Error(`publish-source-sha ${publishSourceSha} does not match promotion sha ${sha}`);
  }
  const parsed = parseLockedPublishSource(publishSourceRef);
  const locked = String(publishSourceLocked || "").toLowerCase();
  const effectiveSha = publishSourceSha || sha || "";
  const sourceLockReport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publish-source-lock-validation",
    ok: false,
    checks: [
      checkSourceLock(
        locked === "true" || locked === "1" || publishSourceLocked === true,
        "publish.source_locked",
        "publish source lock is required before package publication",
        { sourceLocked: publishSourceLocked || "" },
      ),
      checkSourceLock(
        !!parsed.channel,
        "publish.source_ref",
        "publish source ref uses publish-gate/{alpha,release,major}",
        { sourceRef: parsed.sourceRef || publishSourceRef || "", channel: parsed.channel },
      ),
      checkSourceLock(
        /^[0-9a-f]{40}$/i.test(String(effectiveSha)),
        "publish.source_sha",
        "publish source SHA is a 40-character Git SHA",
        { sourceSha: effectiveSha },
      ),
    ],
    summary: {
      publishSource: {
        sourceRef: parsed.sourceRef || publishSourceRef || "",
        sourceSha: effectiveSha,
        sourceLocked: publishSourceLocked || "",
        channel: parsed.channel,
        line: parsed.line,
        consumerVersion: parsed.consumerVersion,
      },
    },
  };
  sourceLockReport.ok = sourceLockReport.checks.every((check) => check.status === "pass");
  if (!sourceLockReport.ok) {
    const failed = sourceLockReport.checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(`publish source-lock validation failed: ${failed}`);
  }
  return sourceLockReport;
}

function assertFile(pathname, label) {
  if (!pathname || !fs.existsSync(pathname) || !fs.statSync(pathname).isFile()) {
    throw new Error(`github-release=true requires ${label}, got '${pathname || ""}'`);
  }
}

export function collectGitHubReleaseEvidenceAssets({
  publishEvidencePath = "",
  releasePassportPath = "",
  releasePassportOutputDir = "",
  additionalAssetPaths = [],
} = {}) {
  assertFile(publishEvidencePath, "a publish evidence file");
  assertFile(releasePassportPath, "buildchain.release.json");
  if (!releasePassportOutputDir || !fs.existsSync(releasePassportOutputDir) || !fs.statSync(releasePassportOutputDir).isDirectory()) {
    throw new Error(`github-release=true requires a release passport output directory, got '${releasePassportOutputDir || ""}'`);
  }
  const assets = [publishEvidencePath];
  for (const entry of fs.readdirSync(releasePassportOutputDir).sort()) {
    const candidate = path.join(releasePassportOutputDir, entry);
    if (fs.statSync(candidate).isFile()) {
      assets.push(candidate);
    }
  }
  if (assets.length < 2) {
    throw new Error(`github-release=true found no release passport assets under ${releasePassportOutputDir}`);
  }
  const occupiedBasenames = new Set(assets.map((assetPath) => path.basename(assetPath)));
  for (const assetPath of additionalAssetPaths) {
    assertFile(assetPath, "a declared GitHub Release artifact");
    const basename = path.basename(assetPath);
    if (occupiedBasenames.has(basename)) {
      throw new Error(`github-release=true found duplicate asset basename '${basename}'`);
    }
    occupiedBasenames.add(basename);
    assets.push(assetPath);
  }
  return assets;
}

async function uploadReleaseAssetClobber({ octokit, owner, repo, releaseId, assetPath }) {
  const name = path.basename(assetPath);
  const existing = await octokit.rest.repos.listReleaseAssets({
    owner,
    repo,
    release_id: releaseId,
    per_page: 100,
  });
  for (const asset of existing.data || []) {
    if (asset.name === name) {
      await octokit.rest.repos.deleteReleaseAsset({
        owner,
        repo,
        asset_id: asset.id,
      });
    }
  }
  await octokit.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name,
    data: fs.readFileSync(assetPath),
  });
}

export async function publishGitHubReleaseEvidence({
  octokit,
  owner,
  repo,
  token,
  apiUrl,
  tag,
  target,
  title = "",
  notes = "",
  publishEvidencePath = "",
  releasePassportPath = "",
  releasePassportOutputDir = "",
  additionalAssetPaths = [],
} = {}) {
  if (!tag) {
    throw new Error("github-release=true requires promote-buildchain-ref to resolve a public release tag");
  }
  const assets = collectGitHubReleaseEvidenceAssets({
    publishEvidencePath,
    releasePassportPath,
    releasePassportOutputDir,
    additionalAssetPaths,
  });
  const release = await ensureGitHubRelease({
    apiUrl,
    token,
    repository: `${owner}/${repo}`,
    tag,
    title: title || tag,
    notes: notes || `Buildchain release passport assets for ${tag}.`,
    target,
  });
  for (const assetPath of assets) {
    await uploadReleaseAssetClobber({
      octokit,
      owner,
      repo,
      releaseId: release.release.id,
      assetPath,
    });
  }
  return {
    action: release.action,
    url: release.release.html_url || "",
    tag,
    assetCount: assets.length,
  };
}

async function main() {
  const token = core.getInput("token", { required: true });
  const sha = core.getInput("sha", { required: true });
  const targetRef = core.getInput("target-ref", { required: true });
  const tagInput = core.getInput("tags");
  const tags = tagInput ? parseTags(tagInput) : undefined;
  const dryRun = core.getBooleanInput("dry-run");
  const requireGovernance = core.getBooleanInput("require-governance");
  const requireVersionState = core.getBooleanInput("require-version-state");
  const verificationCommand = core.getInput("verification-command");
  const reconciliationWorkspace = core.getInput("reconciliation-workspace");
  const requiredStatusCheck = core.getInput("required-status-check") || "check / check";
  const generatedStatusCheckToken = core.getInput("generated-status-check-token") || token;
  const generatedRefUpdateToken = core.getInput("generated-ref-update-token") || token;
  const branchProtectionBypassApps = core.getInput("branch-protection-bypass-apps");
  const branchProtectionBypassUsers = core.getInput("branch-protection-bypass-users");
  const branchProtectionBypassTeams = core.getInput("branch-protection-bypass-teams");
  const allowRepository = core.getInput("allow-repository") || "kungfu-systems/buildchain";
  const publishTransaction = core.getBooleanInput("publish-transaction");
  const publishCommand = core.getInput("publish-command");
  const publishEvidencePath = core.getInput("publish-evidence-path");
  const transactionStatePath = core.getInput("transaction-state-path");
  const publishRequiredArtifactsJson = core.getInput("publish-required-artifacts-json");
  const publishMode = core.getInput("publish-mode");
  const publishAuth = core.getInput("publish-auth");
  const publishDistTag = core.getInput("publish-dist-tag");
  const publishPackageSetOrder = core.getInput("publish-package-set-order");
  const publishPackageMain = core.getInput("publish-package-main");
  const expectedPublicationVersion = core.getInput("expected-publication-version");
  const requirePublishSourceLock = core.getBooleanInput("require-publish-source-lock");
  const publishSourceRef = core.getInput("publish-source-ref");
  const publishSourceSha = core.getInput("publish-source-sha");
  const publishSourceLocked = core.getInput("publish-source-locked");
  const releaseMaterialSha = core.getInput("release-material-sha");
  const publishToolingSha = core.getInput("publish-tooling-sha");
  const publishTransactionOverride = core.getBooleanInput("publish-transaction-override");
  const releasePassport = core.getBooleanInput("release-passport");
  const releasePassportOutputDir = core.getInput("release-passport-output-dir");
  const releasePassportProductName = core.getInput("release-passport-product-name");
  const releasePassportBuildSummaryPath = core.getInput("release-passport-build-summary-path");
  const releasePassportPlatformManifestPaths = core.getInput("release-passport-platform-manifest-paths");
  const releasePassportImpactJson = core.getInput("release-passport-impact-json");
  const releasePassportKfd1WitnessJsons = core.getInput("release-passport-kfd-1-witness-jsons");
  const releasePassportKfd2ClaimJsons = core.getInput("release-passport-kfd-2-claim-jsons");
  const releasePassportKfd3PrebuildWitnessJsons = core.getInput("release-passport-kfd-3-prebuild-witness-jsons");
  const releasePassportKfd3ArtifactWitnessJsons = core.getInput("release-passport-kfd-3-artifact-witness-jsons");
  const releasePassportKfd3ArtifactVerifyCommand = core.getInput("release-passport-kfd-3-artifact-verify-command");
  const releasePassportKfd7DeclarationJsons = core.getInput("release-passport-kfd-7-declaration-jsons");
  const releasePassportKfdAgentRuntimeWitnessJsons = core.getInput("release-passport-kfd-agent-runtime-witness-jsons");
  const releasePassportBuildchainSelfKfd = core.getBooleanInput("release-passport-buildchain-self-kfd");
  const githubRelease = core.getBooleanInput("github-release");
  const githubReleaseArtifactPaths = core.getMultilineInput("github-release-artifact-paths")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const githubReleaseTitle = core.getInput("github-release-title");
  const githubReleaseNotes = core.getInput("github-release-notes");
  const promoteOnlyReleaseCandidate = core.getBooleanInput("promote-only-release-candidate");
  const releaseCandidatePassportPath = core.getInput("release-candidate-passport-path");
  const releaseCandidateBuildSummaryPath = core.getInput("release-candidate-build-summary-path");
  const releaseCandidateVersion = core.getInput("release-candidate-version");
  const octokit = github.getOctokit(token);
  const statusCheckOctokit =
    generatedStatusCheckToken === token ? octokit : github.getOctokit(generatedStatusCheckToken);
  const refUpdateOctokit =
    generatedRefUpdateToken === token ? octokit : github.getOctokit(generatedRefUpdateToken);
  if (requirePublishSourceLock) {
    const sourceLockReport = validateRequiredPublishSourceLock({
      sha,
      publishSourceRef,
      publishSourceSha,
      publishSourceLocked,
    });
    core.info(`publish source-lock validation ok: ${sourceLockReport.summary.publishSource.sourceRef}`);
  }
  if (dryRun) {
    console.log(formatReleaseLineDryRun(explainReleaseLineDryRun({
      targetRef,
      sha,
      tags,
      publishTransaction,
      publishCommand,
      publishMode,
      publishAuth,
    })));
  }
  const result = await promoteBuildchainRefs({
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
    requireGovernance,
    requireVersionState,
    verificationCommand,
    reconciliationWorkspace,
    requiredStatusCheck,
    statusCheckOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    publishTransaction,
    publishCommand,
    publishEvidencePath,
    transactionStatePath,
    publishRequiredArtifactsJson,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    expectedPublicationVersion,
    releaseMaterialSha,
    publishToolingSha,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfd7DeclarationJsons,
    releasePassportKfdAgentRuntimeWitnessJsons,
    releasePassportBuildchainSelfKfd,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    actor: github.context.actor,
    runId: String(github.context.runId || ""),
    publishTransactionOverride,
  });

  for (const update of result.updates) {
    const target =
      update.tag ||
      update.ref ||
      (update.version ? `version-state ${update.version}` : "promotion");
    const detail = update.files?.length ? ` (${update.files.join(", ")})` : "";
    console.log(`${update.action}: ${target} -> ${update.sha}${detail}`);
  }
  core.setOutput("sha", result.sha);
  core.setOutput("next-anchor-required", String(result.nextAlphaRequired === true));
  core.setOutput("transaction-id", result.publishTransaction?.id || "");
  core.setOutput("transaction-state", result.publishTransaction?.state || "");
  core.setOutput("transaction-exact-tag", result.publishTransaction?.exactTag || "");
  const plannedPublication = result.updates.find(
    (update) => update.action === "dry-run-publish-transaction",
  );
  core.setOutput("planned-publication-version", plannedPublication?.version || "");
  core.setOutput("planned-publication-exact-tag", plannedPublication?.tag || "");
  core.setOutput("public-release-tag", result.publishTransaction?.publicReleaseTag || result.publishTransaction?.exactTag || "");
  core.setOutput("transaction-release-sha", result.publishTransaction?.releaseSha || "");
  core.setOutput("transaction-state-ref", result.publishTransaction?.stateRef || "");
  core.setOutput("transaction-state-sha", result.publishTransaction?.stateSha || "");
  core.setOutput("transaction-state-path", result.publishTransaction?.statePath || "");
  core.setOutput("publish-evidence-path", result.publishTransaction?.evidencePath || "");
  core.setOutput("release-passport-path", result.publishTransaction?.releasePassportPath || "");
  core.setOutput("release-passport-output-dir", result.publishTransaction?.releasePassportOutputDir || "");
  core.setOutput("release-passport-state-sha", result.publishTransaction?.releasePassportStateSha || "");
  core.setOutput(
    "finalization-needed",
    String(result.publishTransaction?.finalizationNeeded === true),
  );
  let githubReleaseResult;
  if (githubRelease && !dryRun) {
    if (result.publishTransaction?.state === "complete" && result.publishTransaction?.finalizationNeeded !== true) {
      githubReleaseResult = await publishGitHubReleaseEvidence({
        octokit,
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        token,
        apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
        tag: result.publishTransaction?.publicReleaseTag || result.publishTransaction?.exactTag || "",
        target: result.publishTransaction?.releaseSha || sha,
        title: githubReleaseTitle,
        notes: githubReleaseNotes,
        publishEvidencePath: result.publishTransaction?.evidencePath || "",
        releasePassportPath: result.publishTransaction?.releasePassportPath || "",
        releasePassportOutputDir: result.publishTransaction?.releasePassportOutputDir || "",
        additionalAssetPaths: githubReleaseArtifactPaths,
      });
      core.info(`github release ${githubReleaseResult.action}: ${githubReleaseResult.tag} (${githubReleaseResult.assetCount} assets)`);
    } else {
      core.info(
        `github-release=true is waiting for a complete release transaction before creating or updating the public GitHub Release; transaction-state=${result.publishTransaction?.state || ""} finalization-needed=${result.publishTransaction?.finalizationNeeded === true}`,
      );
    }
  }
  core.setOutput("github-release-url", githubReleaseResult?.url || "");
  core.setOutput("github-release-action", githubReleaseResult?.action || "");
  core.setOutput(
    "tags",
    result.updates
      .map((update) => update.tag)
      .filter(Boolean)
      .join(","),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failureMessage = String(error?.message || error || "promotion failed")
      .replace(/\r?\n/g, " ")
      .slice(0, 2000);
    core.setOutput("failure-message", failureMessage);
    console.error(error);
    core.setFailed(failureMessage);
  });
}
