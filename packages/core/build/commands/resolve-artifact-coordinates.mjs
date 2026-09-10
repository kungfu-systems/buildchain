#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveArtifactCoordinates } from "../artifact/coordinates.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
function required(value, label) { if (!String(value || "").trim()) throw new Error(`${label} is required`); return String(value).trim(); }
function parseArray(value, label) { const result = JSON.parse(value); if (!Array.isArray(result) || !result.length) throw new Error(`${label} must be a non-empty JSON array`); return result; }
export function resolveArtifactCoordinatesCli(env = process.env) {
  const artifactListPath = required(
    env.BUILDCHAIN_ARTIFACT_LIST_PATH,
    "BUILDCHAIN_ARTIFACT_LIST_PATH",
  );
  const outputPath = required(
    env.BUILDCHAIN_ARTIFACT_COORDINATES_PATH,
    "BUILDCHAIN_ARTIFACT_COORDINATES_PATH",
  );
  const artifacts = parseArray(
    fs.readFileSync(artifactListPath, "utf8"),
    "artifact list",
  );
  const platforms = parseArray(
    env.BUILDCHAIN_PLATFORMS_JSON || "",
    "platforms-json",
  );
  const result = resolveArtifactCoordinates({
    artifacts,
    platforms,
    artifactName: env.BUILDCHAIN_ARTIFACT_NAME,
    artifactNameTemplate: env.BUILDCHAIN_ARTIFACT_NAME_TEMPLATE,
    sourceSha: env.BUILDCHAIN_SOURCE_SHA,
    sourceRef: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    serverUrl: env.GITHUB_SERVER_URL,
  });
  const pretty = `${JSON.stringify(result, null, 2)}\n`;
  const compact = JSON.stringify(result);
  fs.writeFileSync(outputPath, pretty);
  writeGitHubOutputs({
    "artifact-coordinates-json": compact,
    "artifact-coordinates-path": outputPath,
  });
  process.stdout.write(pretty);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    resolveArtifactCoordinatesCli();
  } catch (error) {
    console.error(`resolve-artifact-coordinates: ${error.message}`);
    process.exitCode = 1;
  }
}
