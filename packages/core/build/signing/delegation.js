import fs from "node:fs";
import path from "node:path";

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

function sha256Root(value, label) {
  const normalized = optional(value, label);
  if (normalized && !/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a canonical sha256 root`);
  }
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
      sha: value.runtime?.sha,
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
      root: sha256Root(value.request?.root, "request.root"),
    },
    authority: {
      runtimeSha:
        requestCount > 0
          ? value.authority?.runtimeSha
          : optional(value.authority?.runtimeSha, "authority.runtimeSha"),
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
    controller: {
      mode: optional(value.controller?.mode, "controller.mode"),
      receiptDigest: sha256Root(
        value.controller?.receiptDigest,
        "controller.receiptDigest",
      ),
    },
  };
  if (
    requestCount === 0 &&
    (delegation.authority.runtimeSha ||
      delegation.authority.runId ||
      delegation.authority.resultArtifact)
  ) {
    throw new Error(
      "unsigned delegation must not contain authority result coordinates",
    );
  }
  if (
    Boolean(delegation.controller.mode) !==
    Boolean(delegation.controller.receiptDigest)
  ) {
    throw new Error(
      "delegation controller mode and receipt digest must be provided together",
    );
  }
  return delegation;
}

export function createArtifactSigningDelegation({
  sourceRepository,
  sourceRunId,
  sourceRunAttempt = "1",
  sourceSha,
  sourceTreeSha,
  runtimeRepository,
  runtimeSha,
  platformId,
  platformName,
  requestCount = "0",
  requestArtifact = "",
  requestRoot = "",
  authorityRunId = "",
  authorityRuntimeSha = "",
  resultArtifact = "",
  artifactName,
  manifestArtifact,
  diagnosticsArtifact,
  workingDirectory = ".",
  controllerMode = "",
  controllerReceiptDigest = "",
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
    request: {
      count: Number(requestCount),
      artifact: requestArtifact,
      root: requestRoot,
    },
    authority: {
      runtimeSha: authorityRuntimeSha,
      runId: authorityRunId,
      resultArtifact,
    },
    artifact: { name: artifactName, manifestArtifact, diagnosticsArtifact },
    workingDirectory,
    controller: {
      mode: controllerMode,
      receiptDigest: controllerReceiptDigest,
    },
  });
}

export function sealArtifactSigningDelegation({ outputPath, ...values } = {}) {
  const delegation = createArtifactSigningDelegation(values);
  const target = path.resolve(required(outputPath, "delegation output path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(delegation, null, 2)}\n`);
  return delegation;
}

export function readArtifactSigningDelegation(inputPath) {
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
    "authority-runtime-sha": value.authority.runtimeSha,
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
    sourceRepository = "",
    sourceRunId = "",
    sourceRunAttempt = "",
    sourceSha = "",
    runtimeRepository = "",
    runtimeSha = "",
    platformId = "",
  } = {},
) {
  const value = validateArtifactSigningDelegation(delegation);
  const expectations = [
    [sourceRepository, value.source.repository, "source repository"],
    [sourceRunId, value.source.runId, "source run ID"],
    [sourceRunAttempt, String(value.source.runAttempt), "source run attempt"],
    [sourceSha, value.source.sha, "source SHA"],
    [platformId, value.platform.id, "platform ID"],
  ];
  for (const [expected, actual, label] of expectations) {
    if (expected && String(expected) !== actual)
      throw new Error(`artifact signing delegation ${label} mismatch`);
  }
  return value;
}
