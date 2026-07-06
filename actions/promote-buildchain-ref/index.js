import * as core from "@actions/core";
import * as github from "@actions/github";
import { pathToFileURL } from "node:url";
import { parseTags, promoteBuildchainRefs } from "./lib.js";
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../../packages/core/release-line-dry-run.js";
import { validateAnchoredPackageRelease } from "../../packages/core/diagnostics.js";

export function validateRequiredPublishSourceLock({
  cwd = process.cwd(),
  sha,
  publishSourceRef = "",
  publishSourceSha = "",
  publishSourceLocked = "",
} = {}) {
  if (publishSourceSha && publishSourceSha !== sha) {
    throw new Error(`publish-source-sha ${publishSourceSha} does not match promotion sha ${sha}`);
  }
  const sourceLockReport = validateAnchoredPackageRelease({
    cwd,
    requirePublishGateSourceLock: true,
    publishSource: {
      sourceRef: publishSourceRef,
      sourceSha: publishSourceSha || sha,
      sourceLocked: publishSourceLocked,
    },
  });
  if (!sourceLockReport.ok) {
    const failed = sourceLockReport.checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(`anchored publish source-lock validation failed: ${failed}`);
  }
  return sourceLockReport;
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
  const requiredStatusCheck = core.getInput("required-status-check") || "check";
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
  const releasePassportKfd3PrebuildWitnessJsons = core.getInput("release-passport-kfd-3-prebuild-witness-jsons");
  const releasePassportKfd3ArtifactWitnessJsons = core.getInput("release-passport-kfd-3-artifact-witness-jsons");
  const releasePassportKfd3ArtifactVerifyCommand = core.getInput("release-passport-kfd-3-artifact-verify-command");
  const promoteOnlyReleaseCandidate = core.getBooleanInput("promote-only-release-candidate");
  const releaseCandidatePassportPath = core.getInput("release-candidate-passport-path");
  const releaseCandidateBuildSummaryPath = core.getInput("release-candidate-build-summary-path");
  const releaseCandidateVersion = core.getInput("release-candidate-version");
  const octokit = github.getOctokit(token);
  if (requirePublishSourceLock) {
    const sourceLockReport = validateRequiredPublishSourceLock({
      sha,
      publishSourceRef,
      publishSourceSha,
      publishSourceLocked,
    });
    core.info(`anchored publish source-lock validation ok: ${sourceLockReport.summary.publishSource.sourceRef}`);
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
    requiredStatusCheck,
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
    releaseMaterialSha,
    publishToolingSha,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
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
    console.error(error);
    core.setFailed(error.message);
  });
}
