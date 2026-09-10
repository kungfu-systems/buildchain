#!/usr/bin/env node
import { importArtifactSigningResults } from "../signing/import-results.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
try { writeGitHubOutputs(importArtifactSigningResults({
  workspace: process.env.GITHUB_WORKSPACE || process.cwd(),
  cwd: process.env.BUILDCHAIN_SIGNING_CWD || ".",
  requestRoot: process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  resultRoot: process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
  evidenceRoot: process.env.BUILDCHAIN_SIGNING_IMPORTED_EVIDENCE_ROOT || ".buildchain/artifacts/signing",
}).outputs); } catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
