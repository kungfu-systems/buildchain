#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { verifyArtifactSigningResults } from "./verify-artifact-signing-results.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function resolveBelow(root, relative, label) {
  const target = path.resolve(root, required(relative, label));
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${label} must resolve below its root`);
  return target;
}

export function importArtifactSigningResults({
  workspace = process.env.GITHUB_WORKSPACE || process.cwd(),
  cwd = process.env.BUILDCHAIN_SIGNING_CWD || ".",
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  resultRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
  evidenceRoot = process.env.BUILDCHAIN_SIGNING_IMPORTED_EVIDENCE_ROOT || ".buildchain/artifacts/signing",
} = {}) {
  const sourceRoot = path.resolve(workspace, cwd);
  const requests = path.resolve(required(requestRoot, "signing request root"));
  const results = path.resolve(required(resultRoot, "signing result root"));
  const verification = verifyArtifactSigningResults({ requestRoot: requests, resultRoot: results });
  const requestIndex = JSON.parse(fs.readFileSync(path.join(requests, "index.json"), "utf8"));
  const resultIndex = JSON.parse(fs.readFileSync(path.join(results, "index.json"), "utf8"));
  const byId = new Map();
  for (const entry of requestIndex.requests || []) {
    const request = JSON.parse(fs.readFileSync(resolveBelow(requests, entry.path, "request path"), "utf8"));
    const check = validateArtifactSigningRequest(request);
    if (!check.ok || request.digest !== entry.digest) throw new Error(`invalid request during result import: ${entry.id}`);
    byId.set(entry.id, request);
  }
  const imported = [];
  for (const entry of resultIndex.results || []) {
    const request = byId.get(entry.id);
    if (!request) throw new Error(`result has no local sealed request: ${entry.id}`);
    const resultPath = resolveBelow(results, entry.result, "result path");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const payload = resolveBelow(path.dirname(resultPath), result.artifact.path, "signed payload");
    const target = resolveBelow(sourceRoot, request.artifact.path, "consumer artifact path");
    const mode = fs.statSync(target).mode;
    fs.copyFileSync(payload, target);
    fs.chmodSync(target, mode);
    const destination = path.resolve(sourceRoot, evidenceRoot, entry.id);
    const rel = path.relative(sourceRoot, destination);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("imported signing evidence escapes consumer source root");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.dirname(resultPath), destination, { recursive: true, force: false, errorOnExist: true });
    imported.push({ id: entry.id, path: request.artifact.path, resultDigest: result.digest });
  }
  writeGitHubOutputs({
    "imported-count": String(imported.length),
    "imported-json": JSON.stringify(imported),
    "evidence-root": path.resolve(sourceRoot, evidenceRoot),
  });
  return { ...verification, imported };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    importArtifactSigningResults();
  } catch (error) {
    console.error(`::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  }
}
