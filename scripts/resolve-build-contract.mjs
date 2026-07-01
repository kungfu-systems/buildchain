#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  resolveArtifactContract,
  resolveRunnerMatrix,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

export function resolveBuildContractCli() {
  const mode = readArg("mode", process.env.BUILDCHAIN_CONTRACT_MODE || "artifact");
  if (mode === "runners") {
    const resolved = resolveRunnerMatrix({
      runnerPreset: process.env.BUILDCHAIN_RUNNER_PRESET || "github-hosted",
      platformsJson: process.env.BUILDCHAIN_PLATFORMS_JSON || "",
    });
    writeGitHubOutputs({
      "runner-preset": resolved.runnerPreset,
      "platforms-json": resolved.platformsJson,
      "platform-count": String(resolved.platformCount),
      "platform-source": resolved.source,
    });
    return resolved;
  }
  if (mode === "artifact") {
    const resolved = resolveArtifactContract({
      artifactName: process.env.BUILDCHAIN_ARTIFACT_NAME || "buildchain-artifact",
      artifactNameTemplate:
        process.env.BUILDCHAIN_ARTIFACT_NAME_TEMPLATE || "{artifact}-{platform}-{sha}",
      platformId: process.env.BUILDCHAIN_PLATFORM_ID || "",
      platformName: process.env.BUILDCHAIN_PLATFORM_NAME || "",
      sha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "",
      ref: process.env.GITHUB_REF || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    });
    writeGitHubOutputs({
      "artifact-name": resolved.artifactName,
      "artifact-base-name": resolved.artifactBaseName,
      "artifact-name-template": resolved.artifactNameTemplate,
      "platform-id": resolved.platform.id,
      "platform-name": resolved.platform.name,
    });
    return resolved;
  }
  throw new Error(`unsupported build contract mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    resolveBuildContractCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
