#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  RECEIPT_CONTRACT,
  artifactSigningControlRequestOutputs,
  assertArtifactSigningControlRequestContext,
  digestDocument,
  normalizeControllerStatus,
  readArtifactSigningControlRequest,
  required,
  sealArtifactSigningControlRequest,
  validateArtifactSigningControlRequest,
  validateArtifactSigningControllerReceipt,
} from "./artifact-signing-controller-core.mjs";
import {
  assertArtifactSigningDelegationContext,
  artifactSigningDelegationOutputs,
  createArtifactSigningDelegation,
  readArtifactSigningDelegation,
} from "./artifact-signing-delegation.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

export {
  artifactSigningCorrelation,
  artifactSigningRequestRoot,
  artifactSigningControlRequestOutputs,
  assertArtifactSigningControlRequestContext,
  createArtifactSigningControlRequest,
  readArtifactSigningControlRequest,
  sealArtifactSigningControlRequest,
  validateArtifactSigningControlRequest,
  validateArtifactSigningControllerReceipt,
} from "./artifact-signing-controller-core.mjs";

export function settleArtifactSigningControl({
  request,
  authorityStatus = process.env.BUILDCHAIN_AUTHORITY_STATUS || "failed",
  authorityRunId = process.env.BUILDCHAIN_AUTHORITY_RUN_ID || "",
  authorityRunUrl = process.env.BUILDCHAIN_AUTHORITY_RUN_URL || "",
  authorityResultArtifact = process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT ||
    "",
  authorityCorrelationId = process.env.BUILDCHAIN_AUTHORITY_CORRELATION_ID ||
    "",
  authorityConclusion = process.env.BUILDCHAIN_AUTHORITY_CONCLUSION || "",
  controllerRepository = process.env.GITHUB_REPOSITORY,
  controllerRunId = process.env.GITHUB_RUN_ID,
  controllerRunAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
  controllerJob = process.env.GITHUB_JOB || "artifact-signing-control",
  controllerRunnerOs = process.env.RUNNER_OS || "Linux",
  controllerStartedAt = process.env.BUILDCHAIN_CONTROLLER_STARTED_AT ||
    new Date().toISOString(),
  controllerCompletedAt = process.env.BUILDCHAIN_CONTROLLER_COMPLETED_AT ||
    new Date().toISOString(),
  receiptPath = process.env.BUILDCHAIN_SIGNING_CONTROLLER_RECEIPT_PATH,
  delegationPath = process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH,
} = {}) {
  const control = validateArtifactSigningControlRequest(request);
  const status = normalizeControllerStatus(authorityStatus);
  const expectedStatus = control.request.count === 0 ? "skipped" : "succeeded";
  const qualifying =
    status === expectedStatus &&
    (control.request.count === 0 || authorityConclusion === "success");
  if (
    authorityCorrelationId &&
    authorityCorrelationId !== control.authority.correlationId
  ) {
    throw new Error("authority correlation does not match control request");
  }
  if (
    authorityResultArtifact &&
    authorityResultArtifact !== control.authority.resultArtifact
  ) {
    throw new Error("authority result artifact does not match control request");
  }
  const receipt = {
    schemaVersion: 1,
    contract: RECEIPT_CONTRACT,
    requestDigest: control.digest,
    source: control.source,
    runtime: {
      repository: control.runtime.repository,
      sha: control.runtime.sha,
    },
    platform: control.platform,
    request: control.request,
    authority: {
      repository: control.authority.repository,
      runId: control.request.count > 0 ? authorityRunId : "",
      runUrl: control.request.count > 0 ? authorityRunUrl : "",
      resultArtifact: control.request.count > 0 ? authorityResultArtifact : "",
      correlationId: control.authority.correlationId,
      conclusion:
        control.request.count > 0
          ? authorityConclusion || status
          : "not-required",
    },
    controller: {
      repository: controllerRepository,
      runId: controllerRunId,
      runAttempt: Number(controllerRunAttempt),
      job: controllerJob,
      runnerOs: controllerRunnerOs,
      startedAt: controllerStartedAt,
      completedAt: controllerCompletedAt,
      status,
    },
    qualifying,
  };
  receipt.digest = digestDocument(receipt);
  const validatedReceipt = validateArtifactSigningControllerReceipt(receipt);
  const resolvedReceiptPath = path.resolve(
    required(receiptPath, "controller receipt path"),
  );
  fs.mkdirSync(path.dirname(resolvedReceiptPath), { recursive: true });
  fs.writeFileSync(
    resolvedReceiptPath,
    `${JSON.stringify(validatedReceipt, null, 2)}\n`,
  );

  let delegation = null;
  if (validatedReceipt.qualifying) {
    delegation = createArtifactSigningDelegation({
      sourceRepository: control.source.repository,
      sourceRunId: control.source.runId,
      sourceRunAttempt: control.source.runAttempt,
      sourceSha: control.source.sha,
      sourceTreeSha: control.source.treeSha,
      runtimeRepository: control.runtime.repository,
      runtimeSha: control.runtime.sha,
      platformId: control.platform.id,
      platformName: control.platform.name,
      requestCount: control.request.count,
      requestArtifact: control.request.artifact,
      requestRoot: control.request.root,
      authorityRunId: validatedReceipt.authority.runId,
      resultArtifact: validatedReceipt.authority.resultArtifact,
      artifactName: control.artifact.name,
      manifestArtifact: control.artifact.manifestArtifact,
      diagnosticsArtifact: control.artifact.diagnosticsArtifact,
      workingDirectory: control.workingDirectory,
      controllerMode: "detached",
      controllerReceiptDigest: validatedReceipt.digest,
    });
    const resolvedDelegationPath = path.resolve(
      required(delegationPath, "delegation path"),
    );
    fs.mkdirSync(path.dirname(resolvedDelegationPath), { recursive: true });
    fs.writeFileSync(
      resolvedDelegationPath,
      `${JSON.stringify(delegation, null, 2)}\n`,
    );
  }
  return { receipt: validatedReceipt, delegation };
}

export function readArtifactSigningControllerReceipt(
  inputPath = process.env.BUILDCHAIN_SIGNING_CONTROLLER_RECEIPT_PATH,
) {
  const target = path.resolve(required(inputPath, "controller receipt path"));
  return validateArtifactSigningControllerReceipt(
    JSON.parse(fs.readFileSync(target, "utf8")),
  );
}

export function assertArtifactSigningControllerReceipt({
  request,
  receipt,
  delegation,
}) {
  const control = validateArtifactSigningControlRequest(request);
  const result = validateArtifactSigningControllerReceipt(receipt);
  const finalDelegation = assertArtifactSigningDelegationContext(delegation, {
    sourceRepository: control.source.repository,
    sourceRunId: control.source.runId,
    sourceRunAttempt: control.source.runAttempt,
    sourceSha: control.source.sha,
    runtimeRepository: control.runtime.repository,
    runtimeSha: control.runtime.sha,
    platformId: control.platform.id,
  });
  const comparisons = [
    [result.requestDigest, control.digest, "control request digest"],
    [result.source.treeSha, control.source.treeSha, "source tree SHA"],
    [result.request.root, control.request.root, "request root"],
    [result.request.artifact, control.request.artifact, "request artifact"],
    [
      result.authority.correlationId,
      control.authority.correlationId,
      "correlation",
    ],
    [
      result.authority.runId,
      finalDelegation.authority.runId,
      "authority run ID",
    ],
    [
      result.authority.resultArtifact,
      finalDelegation.authority.resultArtifact,
      "authority result artifact",
    ],
    [
      finalDelegation.controller.receiptDigest,
      result.digest,
      "controller receipt digest",
    ],
    [
      finalDelegation.request.root,
      result.request.root,
      "delegation request root",
    ],
  ];
  for (const [actual, expected, label] of comparisons) {
    if (actual !== expected) {
      throw new Error(`artifact signing controller ${label} mismatch`);
    }
  }
  if (!result.qualifying) {
    throw new Error("artifact signing controller receipt is not qualifying");
  }
  return { request: control, receipt: result, delegation: finalDelegation };
}

function expectedContext() {
  return {
    sourceRepository: process.env.BUILDCHAIN_EXPECTED_SOURCE_REPOSITORY || "",
    sourceRunId: process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ID || "",
    sourceRunAttempt: process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ATTEMPT || "",
    sourceSha: process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA || "",
    sourceTreeSha: process.env.BUILDCHAIN_EXPECTED_SOURCE_TREE_SHA || "",
    runtimeRepository: process.env.BUILDCHAIN_EXPECTED_RUNTIME_REPOSITORY || "",
    runtimeSha: process.env.BUILDCHAIN_EXPECTED_RUNTIME_SHA || "",
    platformId: process.env.BUILDCHAIN_EXPECTED_PLATFORM_ID || "",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const mode = process.argv[2] || "seal";
    if (mode === "seal") {
      sealArtifactSigningControlRequest();
    } else if (mode === "outputs") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(),
        expectedContext(),
      );
      writeGitHubOutputs(artifactSigningControlRequestOutputs(request));
    } else if (mode === "settle") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(),
        expectedContext(),
      );
      const { receipt, delegation } = settleArtifactSigningControl({ request });
      writeGitHubOutputs({
        "controller-status": receipt.controller.status,
        "controller-receipt-digest": receipt.digest,
        "controller-qualifying": String(receipt.qualifying),
        "delegation-created": String(Boolean(delegation)),
      });
    } else if (mode === "verify") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(),
        expectedContext(),
      );
      const checked = assertArtifactSigningControllerReceipt({
        request,
        receipt: readArtifactSigningControllerReceipt(),
        delegation: readArtifactSigningDelegation(),
      });
      writeGitHubOutputs({
        ...artifactSigningDelegationOutputs(checked.delegation),
        "request-root": checked.receipt.request.root,
        "controller-receipt-digest": checked.receipt.digest,
        "controller-status": checked.receipt.controller.status,
      });
    } else {
      throw new Error(`unsupported artifact signing controller mode: ${mode}`);
    }
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
