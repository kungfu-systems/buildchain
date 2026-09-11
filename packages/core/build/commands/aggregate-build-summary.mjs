#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateBuildSummary } from "../summary/artifacts.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
const readEnv = (name, fallback = "") => process.env[name] || fallback;
export function aggregateBuildSummaryCli() {
  const inputRoot = path.resolve(readEnv("BUILDCHAIN_SUMMARY_INPUT", ".buildchain/downloaded-manifests"));
  const outputPath = path.resolve(readEnv("BUILDCHAIN_SUMMARY_OUTPUT", ".buildchain/artifacts/build-summary.json"));
  const artifactName = readEnv("BUILDCHAIN_ARTIFACT_NAME", "buildchain-artifact");
  const expectedPlatformCount = Number(readEnv("BUILDCHAIN_PLATFORM_COUNT", "0"));
  const additionalPlatformCount = Number(readEnv("BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT", "0"));
  const summary = aggregateBuildSummary({ inputRoot, outputPath, artifactName, expectedPlatformCount, additionalPlatformCount,
    platforms: JSON.parse(readEnv("BUILDCHAIN_EXPECTED_PLATFORMS_JSON", "[]")), additionalPlatforms: JSON.parse(readEnv("BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON", "[]")),
    git: {
      repository: process.env.GITHUB_REPOSITORY || "",
      sha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "",
      treeSha: process.env.BUILDCHAIN_SOURCE_TREE_SHA || "",
      ref: process.env.BUILDCHAIN_SOURCE_REF || process.env.GITHUB_REF || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    },
    publishGate: {
      trustedEvent: readEnv("BUILDCHAIN_TRUSTED_EVENT", "true") === "true",
      channel: readEnv("BUILDCHAIN_PUBLISH_CHANNEL", "none"),
      allowed: readEnv("BUILDCHAIN_PUBLISH_ALLOWED", "false") === "true",
      reason: readEnv("BUILDCHAIN_PUBLISH_REASON", ""),
    },
    publishSource: {
      ref: readEnv("BUILDCHAIN_PUBLISH_SOURCE_REF", ""),
      sha: readEnv("BUILDCHAIN_PUBLISH_SOURCE_SHA", ""),
      locked: readEnv("BUILDCHAIN_PUBLISH_SOURCE_LOCKED", "false") === "true",
      channel: readEnv("BUILDCHAIN_PUBLISH_SOURCE_CHANNEL", "none"),
      line: readEnv("BUILDCHAIN_PUBLISH_SOURCE_LINE", ""),
      consumerVersion: readEnv("BUILDCHAIN_PUBLISH_SOURCE_CONSUMER_VERSION", ""),
      releaseManifest: readEnv("BUILDCHAIN_RELEASE_MANIFEST_JSON", ""),
    },
    runtime: {
      workflowShellRef: readEnv("BUILDCHAIN_WORKFLOW_SHELL_REF", ""),
      requestedRef: readEnv("BUILDCHAIN_RUNTIME_REQUESTED_REF", ""),
      ref: readEnv("BUILDCHAIN_RUNTIME_REF", ""),
      sha: readEnv("BUILDCHAIN_RUNTIME_SHA", ""),
      class: readEnv("BUILDCHAIN_RUNTIME_CLASS", ""),
      override: readEnv("BUILDCHAIN_RUNTIME_OVERRIDE", "false") === "true",
      trustDecision: readEnv("BUILDCHAIN_RUNTIME_TRUST_DECISION", ""),
      rollbackRef: readEnv("BUILDCHAIN_ROLLBACK_REF", ""),
    },
  });
  writeGitHubOutputs({
    "summary-path": path.relative(process.cwd(), outputPath).split(path.sep).join("/"),
    "platform-count": String(summary.platformCount),
    "artifact-file-count": String(summary.fileCount),
    "artifact-total-bytes": String(summary.totalBytes),
    "artifact-summary-json": JSON.stringify({
      contract: summary.contract,
      artifactName: summary.artifactName,
      platformCount: summary.platformCount,
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      publishGate: summary.publishGate,
      publishSource: summary.publishSource,
      runtime: summary.runtime,
    }),
  });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    aggregateBuildSummaryCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
