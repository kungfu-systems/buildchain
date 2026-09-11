#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "./github-output.mjs";
import { resolveOfflineRunnerFallback } from "../runner/offline-routing.js";
async function main() {
  const resolved = await resolveOfflineRunnerFallback({
    runnerPreset: process.env.BUILDCHAIN_RUNNER_PRESET || "github-hosted",
    platformsJson: process.env.BUILDCHAIN_PLATFORMS_JSON || "",
    repository: process.env.GITHUB_REPOSITORY || "",
    token: process.env.BUILDCHAIN_RUNNER_INVENTORY_TOKEN || "",
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
  });
  writeGitHubOutputs({
    "platforms-json": resolved.platformsJson,
    "fallback-count": String(resolved.fallbackCount),
    "routing-json": JSON.stringify(resolved.routing),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`,
    );
    process.exitCode = 1;
  });
}
