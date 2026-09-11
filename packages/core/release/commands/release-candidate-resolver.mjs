#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
import { resolveReleaseCandidateArtifacts } from "../candidate/resolve.js";
import {
  optionalText,
  releaseCandidateDownloadEnabled,
} from "../candidate/selection.js";
const DEFAULT_WORKFLOW_FILE = "self-build-fixture.yml";
function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function candidatePayloadOutputs(result) {
  return {
    "release-candidate-payload-dir": result.paths?.payloads || "",
    "release-candidate-platform-manifest-paths": (
      result.paths?.platformManifests || []
    ).join(","),
    "release-candidate-platform-manifest-count": String(
      result.platformManifestCount || 0,
    ),
    "release-candidate-github-artifact-attestation-policy-paths": (
      result.paths?.githubArtifactAttestationPolicies || []
    ).join(","),
    "release-candidate-github-artifact-attestation-policy-count": String(
      result.githubArtifactAttestationPolicyCount || 0,
    ),
    "release-candidate-npm-tarball-paths": (
      result.paths?.npmTarballs || []
    ).join(","),
    "release-candidate-npm-tarball-count": String(result.npmTarballCount || 0),
    "release-candidate-github-release-artifact-paths": (
      result.paths?.releaseAssets || []
    ).join("\n"),
    "publish-required-artifacts-json": JSON.stringify(
      result.publishRequiredArtifacts || [],
    ),
    "publish-required-artifacts-path":
      result.paths?.publishRequiredArtifacts || "",
    "publish-sealed-bundle-root": result.paths?.sealedBundleRoot || "",
    "publish-sealed-bundle-manifest": result.paths?.sealedBundleManifest || "",
  };
}

function candidateOutputs(result) {
  return {
    "promote-only-release-candidate": String(result.enabled === true),
    "release-candidate-passport-path": result.paths?.passport || "",
    "release-candidate-build-summary-path": result.paths?.buildSummary || "",
    "release-candidate-stage-capsules-path": result.paths?.stageCapsules || "",
    "release-candidate-publication-qualification-path":
      result.paths?.publicationQualification || "",
    "release-candidate-publication-qualification-root":
      result.publicationQualificationRoot || "",
    "release-candidate-version": result.version || "",
    "release-candidate-publication-version": optionalText(
      result.publicationVersion,
    ),
    "release-candidate-source-sha": result.artifacts?.sourceSha || "",
    "release-candidate-artifact": result.artifacts?.passport || "",
    "release-candidate-build-summary-artifact": result.artifacts?.summary || "",
    "release-candidate-payload-artifacts": (
      result.artifacts?.payloads || []
    ).join(","),
    ...candidatePayloadOutputs(result),
    "release-candidate-run-id": result.run?.id || "",
    "release-candidate-run-url": result.run?.url || "",
    "release-candidate-pr": result.pullRequest?.number
      ? String(result.pullRequest.number)
      : "",
    "release-candidate-diagnosis": result.enabled
      ? `Resolved PR-stage RC passport ${result.artifacts.passport} from ${result.run.url || `run ${result.run.id}`}`
      : result.reason || "",
  };
}

export async function resolveReleaseCandidateArtifactsCli() {
  const result = await resolveReleaseCandidateArtifacts({
    token: env("GITHUB_TOKEN"),
    apiUrl: env("GITHUB_API_URL", "https://api.github.com"),
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
    runtimeSha: env(
      "BUILDCHAIN_CURRENT_RUNTIME_SHA",
      env("BUILDCHAIN_RUNTIME_SHA", env("BUILDCHAIN_TARGET_SHA")),
    ),
    outputDir: env("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate"),
    download: releaseCandidateDownloadEnabled(
      env("BUILDCHAIN_RC_DOWNLOAD", "true"),
    ),
    waitSeconds: env("BUILDCHAIN_RC_WAIT_SECONDS", "600"),
    pollIntervalMs: env("BUILDCHAIN_RC_POLL_INTERVAL_MS", "15000"),
  });
  writeGitHubOutputs(candidateOutputs(result));
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await resolveReleaseCandidateArtifactsCli();
  } catch (error) {
    console.error(
      `::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
