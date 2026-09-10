#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { sealArtifactSigningControlRequest, readArtifactSigningControlRequest, assertArtifactSigningControlRequestContext, artifactSigningControlRequestOutputs } from "../signing/request.js";
import { settleArtifactSigningControl, assertArtifactSigningControllerReceipt, readArtifactSigningControllerReceipt } from "../signing/control.js";
import { readArtifactSigningDelegation, artifactSigningDelegationOutputs } from "../signing/delegation.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
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
      sealArtifactSigningControlRequest({ outputPath: process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH, ...{
  sourceRepository: process.env.GITHUB_REPOSITORY,
  sourceRunId: process.env.GITHUB_RUN_ID,
  sourceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
  sourceSha: process.env.BUILDCHAIN_SOURCE_SHA,
  sourceTreeSha: process.env.BUILDCHAIN_SOURCE_TREE_SHA,
  runtimeRepository: process.env.BUILDCHAIN_RUNTIME_REPOSITORY,
  runtimeRef: process.env.BUILDCHAIN_RUNTIME_REF,
  runtimeSha: process.env.BUILDCHAIN_RUNTIME_SHA,
  platformId: process.env.BUILDCHAIN_PLATFORM_ID,
  platformName: process.env.BUILDCHAIN_PLATFORM_NAME,
  requestCount: process.env.BUILDCHAIN_SIGNING_REQUEST_COUNT || "0",
  requestArtifact: process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT || "",
  requestIndexPath: process.env.BUILDCHAIN_SIGNING_REQUEST_INDEX,
  authorityRepository: process.env.BUILDCHAIN_AUTHORITY_REPOSITORY,
  resultArtifact: process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT || "",
  artifactName: process.env.BUILDCHAIN_ARTIFACT_NAME,
  manifestArtifact: process.env.BUILDCHAIN_MANIFEST_ARTIFACT_NAME,
  diagnosticsArtifact: process.env.BUILDCHAIN_DIAGNOSTICS_ARTIFACT_NAME,
  workingDirectory: process.env.BUILDCHAIN_SIGNING_CWD || ".",
} });
    } else if (mode === "outputs") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH),
        expectedContext(),
      );
      writeGitHubOutputs(artifactSigningControlRequestOutputs(request));
    } else if (mode === "settle") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH),
        expectedContext(),
      );
      const { receipt, delegation } = settleArtifactSigningControl({ request, ...{
  authorityStatus: process.env.BUILDCHAIN_AUTHORITY_STATUS || "failed",
  authorityRunId: process.env.BUILDCHAIN_AUTHORITY_RUN_ID || "",
  authorityRunUrl: process.env.BUILDCHAIN_AUTHORITY_RUN_URL || "",
  authorityResultArtifact: process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT ||
    "",
  authorityCorrelationId: process.env.BUILDCHAIN_AUTHORITY_CORRELATION_ID ||
    "",
  authorityConclusion: process.env.BUILDCHAIN_AUTHORITY_CONCLUSION || "",
  controllerRepository: process.env.GITHUB_REPOSITORY,
  controllerRunId: process.env.GITHUB_RUN_ID,
  controllerRunAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
  controllerJob: process.env.GITHUB_JOB || "artifact-signing-control",
  controllerRunnerOs: process.env.RUNNER_OS || "Linux",
  controllerStartedAt: process.env.BUILDCHAIN_CONTROLLER_STARTED_AT ||
    new Date().toISOString(),
  controllerCompletedAt: process.env.BUILDCHAIN_CONTROLLER_COMPLETED_AT ||
    new Date().toISOString(),
  receiptPath: process.env.BUILDCHAIN_SIGNING_CONTROLLER_RECEIPT_PATH,
  delegationPath: process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH,
  authorityRuntimeSha: process.env.BUILDCHAIN_AUTHORITY_RUNTIME_SHA || "",
} });
      writeGitHubOutputs({
        "controller-status": receipt.controller.status,
        "controller-receipt-digest": receipt.digest,
        "controller-qualifying": String(receipt.qualifying),
        "delegation-created": String(Boolean(delegation)),
      });
    } else if (mode === "verify") {
      const request = assertArtifactSigningControlRequestContext(
        readArtifactSigningControlRequest(process.env.BUILDCHAIN_SIGNING_CONTROL_REQUEST_PATH),
        expectedContext(),
      );
      const checked = assertArtifactSigningControllerReceipt({
        request,
        receipt: readArtifactSigningControllerReceipt(process.env.BUILDCHAIN_SIGNING_CONTROLLER_RECEIPT_PATH),
        delegation: readArtifactSigningDelegation(process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH),
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
