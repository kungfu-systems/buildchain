#!/usr/bin/env node
import path from "node:path";
import { sealArtifactSigningRequests } from "../signing/seal-requests.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
try {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const outputRoot = path.resolve(workspace, process.env.BUILDCHAIN_SIGNING_OUTPUT_ROOT || ".buildchain/signing/requests");
  const index = sealArtifactSigningRequests({ workspace, outputRoot, cwd: process.env.BUILDCHAIN_SIGNING_CWD || ".", manifestPath: process.env.BUILDCHAIN_SIGNING_ARTIFACT_MANIFEST, repository: process.env.BUILDCHAIN_SOURCE_REPOSITORY || process.env.GITHUB_REPOSITORY, sourceSha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA, sourceTreeSha: process.env.BUILDCHAIN_SOURCE_TREE_SHA, runtimeSha: process.env.BUILDCHAIN_RUNTIME_SHA, platformId: process.env.BUILDCHAIN_PLATFORM_ID });
  writeGitHubOutputs({ "request-count": String(index.requests.length), "request-index": path.join(outputRoot, "index.json"), "request-root": outputRoot });
} catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
