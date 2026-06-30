#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findJsonFiles, writeGitHubOutputs } from "./build-contract-core.mjs";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function aggregateBuildSummaryCli() {
  const inputRoot = path.resolve(readEnv("BUILDCHAIN_SUMMARY_INPUT", ".buildchain/downloaded-manifests"));
  const outputPath = path.resolve(readEnv("BUILDCHAIN_SUMMARY_OUTPUT", ".buildchain/artifacts/build-summary.json"));
  const artifactName = readEnv("BUILDCHAIN_ARTIFACT_NAME", "buildchain-artifact");
  const expectedPlatformCount = Number(readEnv("BUILDCHAIN_PLATFORM_COUNT", "0"));
  const manifestFiles = findJsonFiles(inputRoot)
    .filter((file) => path.basename(file) === "manifest.json")
    .sort();
  const manifests = manifestFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  if (expectedPlatformCount > 0 && manifests.length !== expectedPlatformCount) {
    throw new Error(
      `expected ${expectedPlatformCount} platform manifests, found ${manifests.length} under ${inputRoot}`,
    );
  }
  const summary = {
    contract: "kungfu-buildchain-build-summary",
    artifactName,
    git: {
      repository: process.env.GITHUB_REPOSITORY || "",
      sha: process.env.GITHUB_SHA || "",
      ref: process.env.GITHUB_REF || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    },
    platformCount: manifests.length,
    fileCount: manifests.reduce((sum, manifest) => sum + Number(manifest.summary?.fileCount || 0), 0),
    totalBytes: manifests.reduce((sum, manifest) => sum + Number(manifest.summary?.totalBytes || 0), 0),
    platforms: manifests.map((manifest, index) => ({
      artifactName: manifest.artifactName,
      platform: manifest.platform,
      summary: manifest.summary,
      expectedArtifacts: manifest.expectedArtifacts,
      manifestPath: manifestFiles[index],
    })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
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
