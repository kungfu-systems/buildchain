import * as core from "@actions/core";
import { promoteBuildchainRefs } from "./lib.js";
import { readActionInputs } from "./action-inputs.js";
import {
  createProviderClients,
  createPromotionRequest,
} from "./action-request.js";
import {
  reportPromotionResult,
  reportReleaseTailResult,
} from "./action-outputs.js";
import { validateRequiredPublishSourceLock } from "./source-lock.js";
import { publishReleaseTail } from "./release-tail.js";
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../release-line-dry-run.js";
async function main() {
  const inputs = readActionInputs();
  const {
    token,
    sha,
    targetRef,
    tags,
    dryRun,
    requirePublishSourceLock,
    publishSourceRef,
    publishSourceSha,
    publishSourceLocked,
    publishTransaction,
    publishCommand,
    publishMode,
    publishAuth,
    githubRelease,
    releaseTailStatePath,
    githubReleaseArtifactPaths,
  } = inputs;
  const clients = createProviderClients(inputs);
  const { octokit } = clients;
  if (requirePublishSourceLock) {
    const sourceLockReport = validateRequiredPublishSourceLock({
      sha,
      publishSourceRef,
      publishSourceSha,
      publishSourceLocked,
    });
    core.info(
      `publish source-lock validation ok: ${sourceLockReport.summary.publishSource.sourceRef}`,
    );
  }
  if (dryRun) {
    console.log(
      formatReleaseLineDryRun(
        explainReleaseLineDryRun({
          targetRef,
          sha,
          tags,
          publishTransaction,
          publishCommand,
          publishMode,
          publishAuth,
        }),
      ),
    );
  }
  const result = await promoteBuildchainRefs(
    createPromotionRequest(inputs, clients),
  );
  reportPromotionResult(result);
  const githubReleaseResult = await publishReleaseTail({
    enabled: githubRelease,
    dryRun,
    releaseTailStatePath,
    result,
    octokit,
    token,
    sha,
    artifactPaths: githubReleaseArtifactPaths,
    targetRef,
  });
  reportReleaseTailResult(githubReleaseResult, result);
}
export async function runAction() {
  return main().catch((error) => {
    const failureMessage = String(error?.message || error || "promotion failed")
      .replace(/\r?\n/g, " ")
      .slice(0, 2000);
    core.setOutput("failure-message", failureMessage);
    console.error(error);
    core.setFailed(failureMessage);
  });
}
