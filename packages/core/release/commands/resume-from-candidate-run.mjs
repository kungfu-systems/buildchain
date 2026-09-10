#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import { recoveryFailure } from "../release-candidate-recovery.js";
import { outputPath } from "../candidate/payloads.js";
import { resumeFromCandidateRun } from "../recovery/candidate.js";
import { finalizeRuntimeResumeEvidence } from "../recovery/runtime.js";
function env(name, fallback = "") { return process.env[name] || fallback; }
function requiredEnv(name) {
  const value = env(name).trim();
  if (!value) throw new Error(`${name} is required for candidate recovery`);
  return value;
}
export async function resumeFromCandidateRunCli() {
  try {
    const result = await resumeFromCandidateRun({
      token: env("GITHUB_TOKEN"), apiUrl: env("GITHUB_API_URL", "https://api.github.com"), recoveryRunId: env("GITHUB_RUN_ID"), recoveryRunAttempt: env("GITHUB_RUN_ATTEMPT", "1"),
      authorizationPath: path.resolve(".buildchain/release-candidate/runtime-authorization.json"), authorizationJson: env("BUILDCHAIN_RUNTIME_AUTHORIZATION_JSON"), authorizationRoot: env("BUILDCHAIN_RUNTIME_AUTHORIZATION_ROOT"),
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
      transactionId: env("BUILDCHAIN_RESUME_TRANSACTION_ID"), rematerializeOnResume: env("BUILDCHAIN_PUBLISH_REMATERIALIZE_ON_RESUME") === "true",
      artifactName: env("BUILDCHAIN_ARTIFACT_NAME"),
      artifactPatterns: env("BUILDCHAIN_ARTIFACT_PATTERNS"),
      releasePatterns: env("BUILDCHAIN_GITHUB_RELEASE_PAYLOAD_PATTERNS"),
      requiredArtifactCount: env("BUILDCHAIN_REQUIRED_ARTIFACT_COUNT", "0"),
      publishArtifactKind: env("BUILDCHAIN_PUBLISH_ARTIFACT_KIND", "npm"),
      publishPackageMain: env("BUILDCHAIN_PUBLISH_PACKAGE_MAIN"),
      outputDir: env("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate-recovery"),
    });
    writeGitHubOutputs({
      "promote-only-release-candidate": "true",
      "release-candidate-action": result.action,
      "release-candidate-passport-path": result.paths.passport,
      "release-candidate-build-summary-path": result.paths.buildSummary,
      "release-candidate-version": result.candidateVersion, "release-candidate-publication-version": result.version,
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
      "release-candidate-stage-capsules-path": result.paths.stageCapsules,
      "release-candidate-publication-qualification-path": result.paths.publicationQualification,
      "v4-runtime-resume-evidence-path": result.paths.runtimeResumeEvidence,
      "v4-runtime-resume-finalize-command": result.paths.runtimeResumeEvidence ? "node .buildchain/runtime/promotion-shell/packages/core/release/commands/resume-from-candidate-run.mjs finalize" : "",
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
  const operation = process.argv[2] === "finalize"
    ? finalizeRuntimeResumeEvidence({
        token: env("GITHUB_TOKEN", env("INPUT_TOKEN")), apiUrl: env("GITHUB_API_URL", "https://api.github.com"), expectedVersion: env("BUILDCHAIN_RELEASE_VERSION"), expectedTargetRef: env("BUILDCHAIN_RELEASE_TARGET_REF"),
        materialPath: requiredEnv("BUILDCHAIN_V4_RUNTIME_RESUME_MATERIAL"),
        transaction: JSON.parse(
          requiredEnv("BUILDCHAIN_RELEASE_TRANSACTION_JSON"),
        ),
        outputDir: env(
          "BUILDCHAIN_RELEASE_PASSPORT_OUTPUT_DIR",
          path.dirname(requiredEnv("BUILDCHAIN_V4_RUNTIME_RESUME_MATERIAL")),
        ),
      }).then((result) =>
        console.log(JSON.stringify({ files: [outputPath(result.path)] })),
      )
    : resumeFromCandidateRunCli();
  operation.catch((error) => {
    const failure = error.recoveryFailure || recoveryFailure(error);
    console.error(`candidate recovery rejected [${failure.code}]: ${failure.reason}`);
    console.error(`next action: ${failure.nextAction}`);
    process.exitCode = 1;
  });
}
