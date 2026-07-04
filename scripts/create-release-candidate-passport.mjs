#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createReleaseCandidatePassport } from "./release-candidate-core.mjs";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function createReleaseCandidatePassportCli() {
  const result = createReleaseCandidatePassport({
    outputDir: readEnv("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate"),
    buildSummaryPath: readEnv("BUILDCHAIN_RC_BUILD_SUMMARY", ".buildchain/artifacts/build-summary.json"),
    platformManifestRoot: readEnv("BUILDCHAIN_RC_PLATFORM_MANIFESTS", ".buildchain/downloaded-manifests"),
    artifactName: readEnv("BUILDCHAIN_ARTIFACT_NAME", ""),
    builtSourceSha: readEnv("BUILDCHAIN_BUILT_SOURCE_SHA", readEnv("BUILDCHAIN_SOURCE_SHA")),
    builtSourceTreeSha: readEnv("BUILDCHAIN_BUILT_SOURCE_TREE_SHA"),
    builtSourceRef: readEnv("BUILDCHAIN_BUILT_SOURCE_REF", readEnv("BUILDCHAIN_SOURCE_REF")),
    targetRef: readEnv("BUILDCHAIN_TARGET_REF", ""),
    publishGateRef: readEnv("BUILDCHAIN_PUBLISH_GATE_REF", ""),
    channel: readEnv("BUILDCHAIN_CHANNEL", ""),
    version: readEnv("BUILDCHAIN_VERSION", ""),
    repository: readEnv("GITHUB_REPOSITORY", ""),
    workflowRunId: readEnv("GITHUB_RUN_ID", ""),
    workflowRunAttempt: readEnv("GITHUB_RUN_ATTEMPT", ""),
    pullRequestNumber: readEnv("BUILDCHAIN_PULL_REQUEST_NUMBER", ""),
  });
  console.log(JSON.stringify({
    passportPath: result.passportPath,
    outputDir: result.outputDir,
    builtSourceSha: result.passport.source.builtSourceSha,
    builtSourceTreeSha: result.passport.source.builtSourceTreeSha,
    platformCount: result.passport.build.platformCount,
  }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    createReleaseCandidatePassportCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
