#!/usr/bin/env node
import { dispatchArtifactSigningAuthority } from "../signing/dispatch.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
try { const result = await dispatchArtifactSigningAuthority({
  token: process.env.BUILDCHAIN_AUTHORITY_DISPATCH_TOKEN,
  authorityRepository: process.env.BUILDCHAIN_AUTHORITY_REPOSITORY ||
    "kungfu-systems/buildchain",
  authorityRef: process.env.BUILDCHAIN_AUTHORITY_REF,
  sourceRepository: process.env.GITHUB_REPOSITORY,
  sourceRunId: process.env.GITHUB_RUN_ID,
  sourceRunAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
  requestArtifact: process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT,
  requestRoot: process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT_DIGEST,
  runtimeSha: process.env.BUILDCHAIN_RUNTIME_SHA,
  resultArtifact: process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT,
  correlationId: process.env.BUILDCHAIN_AUTHORITY_CORRELATION_ID || "",
  timeoutSeconds: process.env.BUILDCHAIN_SIGNING_TIMEOUT_SECONDS || "7200",
}); writeGitHubOutputs(result.outputs); }
catch (error) { if (error.authorityOutputs) writeGitHubOutputs(error.authorityOutputs); console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
