#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REQUEST_CONTRACT =
  "kungfu-buildchain-artifact-signing-control-request/v1";
export const RECEIPT_CONTRACT =
  "kungfu-buildchain-artifact-signing-controller-receipt/v1";

export function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (/[\r\n\0]/u.test(normalized)) {
    throw new Error(`${label} contains control characters`);
  }
  return normalized;
}

function optional(value, label) {
  const normalized = String(value || "").trim();
  if (/[\r\n\0]/u.test(normalized)) {
    throw new Error(`${label} contains control characters`);
  }
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

function exactSha(value, label) {
  const normalized = required(value, label);
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(`${label} must be an exact SHA`);
  }
  return normalized;
}

function sha256Root(value, label) {
  const normalized = required(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a canonical sha256 root`);
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
  if (!/^[A-Za-z0-9._ /-]+$/u.test(resolved)) {
    throw new Error(`${label} contains unsafe shell characters`);
  }
  return resolved;
}

function timestamp(value, label) {
  const normalized = required(value, label);
  const parsed = new Date(normalized);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== normalized
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function digestDocument(value) {
  const { digest: _digest, ...body } = value;
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(body)))
    .digest("hex")}`;
}

export function artifactSigningRequestRoot(index) {
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    throw new Error("signing request index must be an object");
  }
  if (
    index.schemaVersion !== 1 ||
    index.contract !== "kungfu-buildchain-artifact-signing-request-index/v1" ||
    !Array.isArray(index.requests)
  ) {
    throw new Error("signing request index contract mismatch");
  }
  for (const [position, entry] of index.requests.entries()) {
    required(entry?.id, `request index entry ${position} id`);
    sha256Root(entry?.digest, `request index entry ${position} digest`);
    safeRelativePath(entry?.path, `request index entry ${position} path`);
  }
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(index)))
    .digest("hex")}`;
}

export function artifactSigningCorrelation({
  sourceRunId,
  sourceRunAttempt,
  runtimeSha,
  platformId,
  requestRoot,
}) {
  return [
    required(sourceRunId, "source run ID"),
    positiveInteger(sourceRunAttempt, "source run attempt"),
    exactSha(runtimeSha, "runtime SHA").slice(0, 12),
    required(platformId, "platform ID").replace(/[^A-Za-z0-9._-]+/gu, "-"),
    sha256Root(requestRoot, "request root").slice("sha256:".length, 19),
  ].join("-");
}

export function validateArtifactSigningControlRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact signing control request must be an object");
  }
  if (value.schemaVersion !== 1 || value.contract !== REQUEST_CONTRACT) {
    throw new Error("artifact signing control request contract mismatch");
  }
  const requestCount = positiveInteger(value.request?.count, "request.count", {
    allowZero: true,
  });
  const request = {
    schemaVersion: 1,
    contract: REQUEST_CONTRACT,
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
      ref: required(value.runtime?.ref, "runtime.ref"),
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
      root: sha256Root(value.request?.root, "request.root"),
    },
    authority: {
      repository: repository(
        value.authority?.repository,
        "authority.repository",
      ),
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
      correlationId: required(
        value.authority?.correlationId,
        "authority.correlationId",
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
    sealedAt: timestamp(value.sealedAt, "sealedAt"),
    digest: sha256Root(value.digest, "digest"),
  };
  const expectedCorrelation = artifactSigningCorrelation({
    sourceRunId: request.source.runId,
    sourceRunAttempt: request.source.runAttempt,
    runtimeSha: request.runtime.sha,
    platformId: request.platform.id,
    requestRoot: request.request.root,
  });
  if (request.authority.correlationId !== expectedCorrelation) {
    throw new Error("artifact signing control request correlation mismatch");
  }
  if (requestCount === 0 && request.authority.resultArtifact) {
    throw new Error(
      "no-signing control request must not name a result artifact",
    );
  }
  if (request.digest !== digestDocument(request)) {
    throw new Error("artifact signing control request digest mismatch");
  }
  return request;
}

export function createArtifactSigningControlRequest({
  sourceRepository = process.env.GITHUB_REPOSITORY,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
  sourceSha = process.env.BUILDCHAIN_SOURCE_SHA,
  sourceTreeSha = process.env.BUILDCHAIN_SOURCE_TREE_SHA,
  runtimeRepository = process.env.BUILDCHAIN_RUNTIME_REPOSITORY,
  runtimeRef = process.env.BUILDCHAIN_RUNTIME_REF,
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  platformId = process.env.BUILDCHAIN_PLATFORM_ID,
  platformName = process.env.BUILDCHAIN_PLATFORM_NAME,
  requestCount = process.env.BUILDCHAIN_SIGNING_REQUEST_COUNT || "0",
  requestArtifact = process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT || "",
  requestIndexPath = process.env.BUILDCHAIN_SIGNING_REQUEST_INDEX,
  authorityRepository = process.env.BUILDCHAIN_AUTHORITY_REPOSITORY,
  resultArtifact = process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT || "",
  artifactName = process.env.BUILDCHAIN_ARTIFACT_NAME,
  manifestArtifact = process.env.BUILDCHAIN_MANIFEST_ARTIFACT_NAME,
  diagnosticsArtifact = process.env.BUILDCHAIN_DIAGNOSTICS_ARTIFACT_NAME,
  workingDirectory = process.env.BUILDCHAIN_SIGNING_CWD || ".",
  sealedAt = new Date().toISOString(),
} = {}) {
  const indexPath = path.resolve(
    required(requestIndexPath, "signing request index path"),
  );
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const root = artifactSigningRequestRoot(index);
  const count = positiveInteger(requestCount, "request count", {
    allowZero: true,
  });
  if (index.requests.length !== count) {
    throw new Error("signing request count does not match the sealed index");
  }
  const correlationId = artifactSigningCorrelation({
    sourceRunId,
    sourceRunAttempt,
    runtimeSha,
    platformId,
    requestRoot: root,
  });
  const request = {
    schemaVersion: 1,
    contract: REQUEST_CONTRACT,
    source: {
      repository: sourceRepository,
      runId: sourceRunId,
      runAttempt: Number(sourceRunAttempt),
      sha: sourceSha,
      treeSha: sourceTreeSha,
    },
    runtime: {
      repository: runtimeRepository,
      ref: runtimeRef,
      sha: runtimeSha,
    },
    platform: { id: platformId, name: platformName },
    request: {
      count,
      artifact: count > 0 ? requestArtifact : "",
      root,
    },
    authority: {
      repository: authorityRepository,
      resultArtifact: count > 0 ? resultArtifact : "",
      correlationId,
    },
    artifact: { name: artifactName, manifestArtifact, diagnosticsArtifact },
    workingDirectory,
    sealedAt,
  };
  request.digest = digestDocument(request);
  return validateArtifactSigningControlRequest(request);
}

export function sealArtifactSigningControlRequest({
  outputPath = process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH,
  ...values
} = {}) {
  const request = createArtifactSigningControlRequest(values);
  const target = path.resolve(required(outputPath, "control request path"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function readArtifactSigningControlRequest(
  inputPath = process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH,
) {
  const target = path.resolve(required(inputPath, "control request path"));
  return validateArtifactSigningControlRequest(
    JSON.parse(fs.readFileSync(target, "utf8")),
  );
}

export function assertArtifactSigningControlRequestContext(
  request,
  {
    sourceRepository = process.env.BUILDCHAIN_EXPECTED_SOURCE_REPOSITORY || "",
    sourceRunId = process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ID || "",
    sourceRunAttempt = process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ATTEMPT || "",
    sourceSha = process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA || "",
    sourceTreeSha = process.env.BUILDCHAIN_EXPECTED_SOURCE_TREE_SHA || "",
    runtimeRepository = process.env.BUILDCHAIN_EXPECTED_RUNTIME_REPOSITORY ||
      "",
    runtimeSha = process.env.BUILDCHAIN_EXPECTED_RUNTIME_SHA || "",
    platformId = process.env.BUILDCHAIN_EXPECTED_PLATFORM_ID || "",
  } = {},
) {
  const value = validateArtifactSigningControlRequest(request);
  const expectations = [
    [sourceRepository, value.source.repository, "source repository"],
    [sourceRunId, value.source.runId, "source run ID"],
    [sourceRunAttempt, String(value.source.runAttempt), "source run attempt"],
    [sourceSha, value.source.sha, "source SHA"],
    [sourceTreeSha, value.source.treeSha, "source tree SHA"],
    [runtimeRepository, value.runtime.repository, "runtime repository"],
    [runtimeSha, value.runtime.sha, "runtime SHA"],
    [platformId, value.platform.id, "platform ID"],
  ];
  for (const [expected, actual, label] of expectations) {
    if (expected && String(expected) !== actual) {
      throw new Error(`artifact signing control request ${label} mismatch`);
    }
  }
  return value;
}

export function artifactSigningControlRequestOutputs(request) {
  const value = validateArtifactSigningControlRequest(request);
  return {
    "request-count": String(value.request.count),
    "request-artifact": value.request.artifact,
    "request-root": value.request.root,
    "result-artifact": value.authority.resultArtifact,
    "correlation-id": value.authority.correlationId,
    "authority-repository": value.authority.repository,
    "authority-ref": value.runtime.ref,
    "runtime-sha": value.runtime.sha,
  };
}

export function normalizeControllerStatus(value) {
  const normalized = required(value, "authority status");
  if (
    !["succeeded", "failed", "timed-out", "cancelled", "skipped"].includes(
      normalized,
    )
  ) {
    throw new Error(`unsupported authority status: ${normalized}`);
  }
  return normalized;
}

export function validateArtifactSigningControllerReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact signing controller receipt must be an object");
  }
  if (value.schemaVersion !== 1 || value.contract !== RECEIPT_CONTRACT) {
    throw new Error("artifact signing controller receipt contract mismatch");
  }
  const receipt = {
    schemaVersion: 1,
    contract: RECEIPT_CONTRACT,
    requestDigest: sha256Root(value.requestDigest, "requestDigest"),
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
      count: positiveInteger(value.request?.count, "request.count", {
        allowZero: true,
      }),
      artifact: optional(value.request?.artifact, "request.artifact"),
      root: sha256Root(value.request?.root, "request.root"),
    },
    authority: {
      repository: repository(
        value.authority?.repository,
        "authority.repository",
      ),
      runId: optional(value.authority?.runId, "authority.runId"),
      runUrl: optional(value.authority?.runUrl, "authority.runUrl"),
      resultArtifact: optional(
        value.authority?.resultArtifact,
        "authority.resultArtifact",
      ),
      correlationId: required(
        value.authority?.correlationId,
        "authority.correlationId",
      ),
      conclusion: required(value.authority?.conclusion, "authority.conclusion"),
    },
    controller: {
      repository: repository(
        value.controller?.repository,
        "controller.repository",
      ),
      runId: required(value.controller?.runId, "controller.runId"),
      runAttempt: positiveInteger(
        value.controller?.runAttempt,
        "controller.runAttempt",
      ),
      job: required(value.controller?.job, "controller.job"),
      runnerOs: required(value.controller?.runnerOs, "controller.runnerOs"),
      startedAt: timestamp(value.controller?.startedAt, "controller.startedAt"),
      completedAt: timestamp(
        value.controller?.completedAt,
        "controller.completedAt",
      ),
      status: normalizeControllerStatus(value.controller?.status),
    },
    qualifying: value.qualifying === true,
    digest: sha256Root(value.digest, "digest"),
  };
  if (
    new Date(receipt.controller.completedAt) <
    new Date(receipt.controller.startedAt)
  ) {
    throw new Error("controller completion predates controller start");
  }
  if (receipt.controller.runnerOs.toLowerCase() === "macos") {
    throw new Error("artifact signing controller must not run on macOS");
  }
  const expectedQualifying =
    receipt.controller.status === "succeeded" ||
    receipt.controller.status === "skipped";
  if (receipt.qualifying !== expectedQualifying) {
    throw new Error("controller receipt qualifying status mismatch");
  }
  if (
    (receipt.request.count === 0) !==
    (receipt.controller.status === "skipped")
  ) {
    throw new Error("controller receipt signing mode and status mismatch");
  }
  if (
    receipt.controller.status === "succeeded" &&
    receipt.authority.conclusion !== "success"
  ) {
    throw new Error("successful controller receipt lacks authority success");
  }
  if (receipt.request.count > 0 && receipt.qualifying) {
    required(receipt.request.artifact, "request.artifact");
    required(receipt.authority.runId, "authority.runId");
    required(receipt.authority.runUrl, "authority.runUrl");
    required(receipt.authority.resultArtifact, "authority.resultArtifact");
  }
  if (
    receipt.request.count === 0 &&
    (receipt.authority.runId ||
      receipt.authority.runUrl ||
      receipt.authority.resultArtifact)
  ) {
    throw new Error("no-signing controller receipt has authority coordinates");
  }
  if (receipt.digest !== digestDocument(receipt)) {
    throw new Error("artifact signing controller receipt digest mismatch");
  }
  return receipt;
}
