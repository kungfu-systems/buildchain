#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  resolveArtifactContract,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function parseArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${label} must be a non-empty JSON array`);
  }
  return parsed;
}

export function resolveArtifactCoordinates({
  artifacts,
  platforms,
  artifactName,
  artifactNameTemplate,
  sourceSha,
  sourceRef = "",
  repository,
  runId,
  runAttempt,
  serverUrl = "https://github.com",
}) {
  if (!Array.isArray(artifacts)) {
    throw new Error("artifacts must be an array");
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error("platforms must be a non-empty array");
  }
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new Error("source SHA must be an exact lowercase commit SHA");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("repository must be an owner/name coordinate");
  }
  if (!/^[1-9][0-9]*$/.test(String(runId))) {
    throw new Error("run id must be a positive integer");
  }
  if (!/^[1-9][0-9]*$/.test(String(runAttempt))) {
    throw new Error("run attempt must be a positive integer");
  }

  const coordinates = platforms.map((platform) => {
    const id = required(platform?.id, "platform id");
    const name = required(platform?.name, `platform ${id} name`);
    const contract = resolveArtifactContract({
      artifactName,
      artifactNameTemplate,
      platformId: id,
      platformName: name,
      sha: sourceSha,
      ref: sourceRef,
      runId: String(runId),
      runAttempt: String(runAttempt),
    });
    const matches = artifacts.filter(
      (artifact) =>
        artifact?.name === contract.artifactName && !artifact.expired,
    );
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one live artifact named ${contract.artifactName}, found ${matches.length}`,
      );
    }
    const artifact = matches[0];
    if (!/^[1-9][0-9]*$/.test(String(artifact.id || ""))) {
      throw new Error(`artifact ${contract.artifactName} has no exact id`);
    }
    if (!DIGEST_PATTERN.test(String(artifact.digest || ""))) {
      throw new Error(`artifact ${contract.artifactName} has no exact digest`);
    }
    if (
      !artifact.expires_at ||
      !Number.isFinite(Date.parse(artifact.expires_at))
    ) {
      throw new Error(`artifact ${contract.artifactName} has no exact expiry`);
    }
    return {
      platformId: id,
      id: String(artifact.id),
      name: artifact.name,
      digest: artifact.digest,
      url: `${serverUrl}/${repository}/actions/runs/${runId}/artifacts/${artifact.id}`,
      expiresAt: new Date(artifact.expires_at).toISOString(),
    };
  });

  coordinates.sort((left, right) =>
    left.platformId.localeCompare(right.platformId),
  );
  return {
    schema: "buildchain.github-artifact-coordinate-set/v1",
    repository,
    runId: String(runId),
    runAttempt: String(runAttempt),
    sourceSha,
    artifacts: coordinates,
  };
}

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
