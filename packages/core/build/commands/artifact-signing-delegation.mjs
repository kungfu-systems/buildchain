#!/usr/bin/env node
import { sealArtifactSigningDelegation, readArtifactSigningDelegation, assertArtifactSigningDelegationContext, artifactSigningDelegationOutputs } from "../signing/delegation.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
try {
  const mode = process.argv[2] || "seal";
  if (mode === "seal") sealArtifactSigningDelegation({ outputPath: process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH, ...{
  sourceRepository: process.env.GITHUB_REPOSITORY,
  sourceRunId: process.env.GITHUB_RUN_ID,
  sourceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
  sourceSha: process.env.BUILDCHAIN_SOURCE_SHA,
  sourceTreeSha: process.env.BUILDCHAIN_SOURCE_TREE_SHA,
  runtimeRepository: process.env.BUILDCHAIN_RUNTIME_REPOSITORY,
  runtimeSha: process.env.BUILDCHAIN_RUNTIME_SHA,
  platformId: process.env.BUILDCHAIN_PLATFORM_ID,
  platformName: process.env.BUILDCHAIN_PLATFORM_NAME,
  requestCount: process.env.BUILDCHAIN_SIGNING_REQUEST_COUNT || "0",
  requestArtifact: process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT || "",
  requestRoot: process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT_DIGEST || "",
  authorityRunId: process.env.BUILDCHAIN_AUTHORITY_RUN_ID || "",
  authorityRuntimeSha: process.env.BUILDCHAIN_AUTHORITY_RUNTIME_SHA || "",
  resultArtifact: process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT || "",
  artifactName: process.env.BUILDCHAIN_ARTIFACT_NAME,
  manifestArtifact: process.env.BUILDCHAIN_MANIFEST_ARTIFACT_NAME,
  diagnosticsArtifact: process.env.BUILDCHAIN_DIAGNOSTICS_ARTIFACT_NAME,
  workingDirectory: process.env.BUILDCHAIN_SIGNING_CWD || ".",
  controllerMode: process.env.BUILDCHAIN_SIGNING_CONTROLLER_MODE || "",
  controllerReceiptDigest: process.env
    .BUILDCHAIN_SIGNING_CONTROLLER_RECEIPT_DIGEST || "",
} });
  else if (mode === "outputs") writeGitHubOutputs(artifactSigningDelegationOutputs(assertArtifactSigningDelegationContext(readArtifactSigningDelegation(process.env.BUILDCHAIN_SIGNING_DELEGATION_PATH), {
    sourceRepository: process.env.BUILDCHAIN_EXPECTED_SOURCE_REPOSITORY, sourceRunId: process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ID, sourceRunAttempt: process.env.BUILDCHAIN_EXPECTED_SOURCE_RUN_ATTEMPT, sourceSha: process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA, runtimeRepository: process.env.BUILDCHAIN_EXPECTED_RUNTIME_REPOSITORY, runtimeSha: process.env.BUILDCHAIN_EXPECTED_RUNTIME_SHA, platformId: process.env.BUILDCHAIN_EXPECTED_PLATFORM_ID,
  })));
  else throw new Error(`unsupported artifact signing delegation mode: ${mode}`);
} catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
