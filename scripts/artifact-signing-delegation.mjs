#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeGitHubOutputs } from "./build-contract-core.mjs";

const CONTRACT = "kungfu-buildchain-artifact-signing-delegation/v1";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (/[\r\n\0]/u.test(normalized))
    throw new Error(`${label} contains control characters`);
  return normalized;
}

function optional(value, label) {
  const normalized = String(value || "").trim();
  if (/[\r\n\0]/u.test(normalized))
    throw new Error(`${label} contains control characters`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = required(value, label);
  if (!/^[0-9a-f]{40}$/u.test(normalized))
    throw new Error(`${label} must be an exact SHA`);
  return normalized;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1)) {
    throw new Error(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return normalized;
}

function repository(value, label) {
  const normalized = required(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
    throw new Error(`${label} must be owner/repository`);
  }
  return normalized;
}

function safeRelativePath(value, label) {
  const normalized = required(value, label).replaceAll("\\", "/");
  const resolved = path.posix.normalize(normalized);
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (!/^[A-Za-z0-9._ /-]+$/u.test(resolved))
    throw new Error(`${label} contains unsafe shell characters`);
  return resolved;
}

export function validateArtifactSigningDelegation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("delegation must be an object");
  if (value.schemaVersion !== 1 || value.contract !== CONTRACT)
    throw new Error("artifact signing delegation contract mismatch");
  const requestCount = positiveInteger(value.request?.count, "request.count", {
    allowZero: true,
  });
  const delegation = {
    schemaVersion: 1,
    contract: CONTRACT,
    source: {
      repository: repository(value.source?.repository, "source.repository"),
      runId: required(value.source?.runId, "source.runId"),
      runAttempt: positiveInteger(
        value.source?.runAttempt,
        "source.runAttempt",
      ),
      sha: exactSha(value.source?.sha, "source.sha"),
      treeSha: exactSha(value.source?.treeSha, "source.treeSha"),
    },
    runtime: {
      repository: repository(value.runtime?.repository, "runtime.repository"),
      sha: exactSha(value.runtime?.sha, "runtime.sha"),
    },
    platform: {
      id: required(value.platform?.id, "platform.id"),
      name: required(value.platform?.name, "platform.name"),
    },
    request: {
      count: requestCount,
      artifact:
        requestCount > 0
          ? required(value.request?.artifact, "request.artifact")
          : optional(value.request?.artifact, "request.artifact"),
    },
    authority: {
      runId:
        requestCount > 0
          ? required(value.authority?.runId, "authority.runId")
          : optional(value.authority?.runId, "authority.runId"),
      resultArtifact:
        requestCount > 0
          ? required(
              value.authority?.resultArtifact,
              "authority.resultArtifact",
            )
          : optional(
              value.authority?.resultArtifact,
              "authority.resultArtifact",
            ),
    },
    artifact: {
      name: required(value.artifact?.name, "artifact.name"),
      manifestArtifact: required(
        value.artifact?.manifestArtifact,
        "artifact.manifestArtifact",
      ),
      diagnosticsArtifact: required(
        value.artifact?.diagnosticsArtifact,
        "artifact.diagnosticsArtifact",
      ),
    },
    workingDirectory: safeRelativePath(
      value.workingDirectory || ".",
      "workingDirectory",
    ),
  };
  if (
    requestCount === 0 &&
    (delegation.authority.runId || delegation.authority.resultArtifact)
  ) {
    throw new Error(
      "unsigned delegation must not contain authority result coordinates",
    );
  }
  return delegation;
}

export function createArtifactSigningDelegation({
  sourceRepository = process.env.GITHUB_REPOSITORY,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
  sourceSha = process.env.BUILDCHAIN_SOURCE_SHA,
  sourceTreeSha = process.env.BUILDCHAIN_SOURCE_TREE_SHA,
  runtimeRepository = process.env.BUILDCHAIN_RUNTIME_REPOSITORY,
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  platformId = process.env.BUILDCHAIN_PLATFORM_ID,
  platformName = process.env.BUILDCHAIN_PLATFORM_NAME,
  requestCount = process.env.BUILDCHAIN_SIGNING_REQUEST_COUNT || "0",
  requestArtifact = process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT || "",
  authorityRunId = process.env.BUILDCHAIN_AUTHORITY_RUN_ID || "",
  resultArtifact = process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT || "",
  artifactName = process.env.BUILDCHAIN_ARTIFACT_NAME,
  manifestArtifact = process.env.BUILDCHAIN_MANIFEST_ARTIFACT_NAME,
  diagnosticsArtifact = process.env.BUILDCHAIN_DIAGNOSTICS_ARTIFACT_NAME,
  workingDirectory = process.env.BUILDCHAIN_SIGNING_CWD || ".",
} = {}) {
  return validateArtifactSigningDelegation({
    schemaVersion: 1,
    contract: CONTRACT,
    source: {
      repository: sourceRepository,
      runId: sourceRunId,
      runAttempt: Number(sourceRunAttempt),
      sha: sourceSha,
      treeSha: sourceTreeSha,
    },
    runtime: { repository: runtimeRepository, sha: runtimeSha },
    platform: { id: platformId, name: platformName },
    request: { count: Number(requestCount), artifact: requestArtifact },
    authority: { runId: authorityRunId, resultArtifact },
    artifact: { name: artifactName, manifestArtifact, diagnosticsArtifact },
    workingDirectory,
  });
}

export function sealArtifactSigningDelegation({
  outputPath = process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH,
  ...values
} = {}) {
  const delegation = createArtifactSigningDelegation(values);
  const target = path.resolve(required(outputPath, "delegation output path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(delegation, null, 2)}\n`);
  return delegation;
}

export function readArtifactSigningDelegation(
  inputPath = process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH,
) {
  const target = path.resolve(required(inputPath, "delegation input path"));
  return validateArtifactSigningDelegation(
    JSON.parse(fs.readFileSync(target, "utf8")),
  );
}

export function artifactSigningDelegationOutputs(delegation) {
  const value = validateArtifactSigningDelegation(delegation);
  return {
    "request-count": String(value.request.count),
    "request-artifact": value.request.artifact,
    "authority-run-id": value.authority.runId,
    "result-artifact": value.authority.resultArtifact,
    "artifact-name": value.artifact.name,
    "manifest-artifact-name": value.artifact.manifestArtifact,
    "diagnostics-artifact-name": value.artifact.diagnosticsArtifact,
    "working-directory": value.workingDirectory,
  };
}

export function assertArtifactSigningDelegationContext(
  delegation,
  {
    sourceRepository = process.env.BUILDCHAIN_EXPECTED_SOURCE_REPOSITORY || "",
    sourceRunId = process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ID || "",
    sourceRunAttempt = process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ATTEMPT || "",
    sourceSha = process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA || "",
    runtimeRepository = process.env.BUILDCHAIN_EXPECTED_RUNTIME_REPOSITORY ||
      "",
    runtimeSha = process.env.BUILDCHAIN_EXPECTED_RUNTIME_SHA || "",
    platformId = process.env.BUILDCHAIN_EXPECTED_PLATFORM_ID || "",
  } = {},
) {
  const value = validateArtifactSigningDelegation(delegation);
  const expectations = [
    [sourceRepository, value.source.repository, "source repository"],
    [sourceRunId, value.source.runId, "source run ID"],
    [sourceRunAttempt, String(value.source.runAttempt), "source run attempt"],
    [sourceSha, value.source.sha, "source SHA"],
    [runtimeRepository, value.runtime.repository, "runtime repository"],
    [runtimeSha, value.runtime.sha, "runtime SHA"],
    [platformId, value.platform.id, "platform ID"],
  ];
  for (const [expected, actual, label] of expectations) {
    if (expected && String(expected) !== actual)
      throw new Error(`artifact signing delegation ${label} mismatch`);
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const mode = process.argv[2] || "seal";
    if (mode === "seal") {
      sealArtifactSigningDelegation();
    } else if (mode === "outputs") {
      const delegation = assertArtifactSigningDelegationContext(
        readArtifactSigningDelegation(),
      );
      writeGitHubOutputs(artifactSigningDelegationOutputs(delegation));
    } else {
      throw new Error(`unsupported artifact signing delegation mode: ${mode}`);
    }
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
