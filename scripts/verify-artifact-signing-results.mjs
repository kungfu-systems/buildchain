#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateArtifactSigningRequest,
} from "../packages/core/artifact-signing.js";
import {
  verifyArtifactSigningResultFiles,
} from "../packages/core/artifact-signing-result.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function resolveBelow(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, required(relative, label));
  const rel = path.relative(resolvedRoot, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must resolve below its root`);
  }
  return target;
}

export function verifyArtifactSigningResults({
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  resultRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
} = {}) {
  const requests = path.resolve(required(requestRoot, "signing request root"));
  const results = path.resolve(required(resultRoot, "signing result root"));
  const requestIndex = JSON.parse(
    fs.readFileSync(path.join(requests, "index.json"), "utf8"),
  );
  const resultIndex = JSON.parse(
    fs.readFileSync(path.join(results, "index.json"), "utf8"),
  );
  if (requestIndex.contract !== "kungfu-buildchain-artifact-signing-request-index/v1") {
    throw new Error("artifact signing request index contract mismatch");
  }
  if (resultIndex.contract !== "kungfu-buildchain-artifact-signing-result-index/v1") {
    throw new Error("artifact signing result index contract mismatch");
  }
  const expected = new Map((requestIndex.requests || []).map((entry) => [entry.id, entry]));
  const verified = [];
  for (const entry of resultIndex.results || []) {
    const requestEntry = expected.get(entry.id);
    if (!requestEntry) throw new Error(`unexpected signing result: ${entry.id}`);
    const request = JSON.parse(
      fs.readFileSync(resolveBelow(requests, requestEntry.path, "request path"), "utf8"),
    );
    const requestCheck = validateArtifactSigningRequest(request);
    if (!requestCheck.ok || request.digest !== requestEntry.digest) {
      throw new Error(`invalid sealed signing request: ${entry.id}`);
    }
    const resultPath = resolveBelow(results, entry.result, "result path");
    const resultDirectory = path.dirname(resultPath);
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const receipt = JSON.parse(
      fs.readFileSync(resolveBelow(resultDirectory, result.receipt.path, "receipt path"), "utf8"),
    );
    const check = verifyArtifactSigningResultFiles({
      root: resultDirectory,
      request,
      receipt,
      result,
    });
    if (!check.ok) {
      throw new Error(`invalid signing result ${entry.id}: ${check.issues.join(", ")}`);
    }
    if (entry.requestDigest !== request.digest || entry.resultDigest !== result.digest) {
      throw new Error(`signing result index binding mismatch: ${entry.id}`);
    }
    expected.delete(entry.id);
    verified.push({ id: entry.id, resultDigest: result.digest });
  }
  const missingRequired = [...expected.values()].filter((entry) => entry.required !== false);
  if (missingRequired.length > 0) {
    throw new Error(`missing required signing results: ${missingRequired.map((entry) => entry.id).join(", ")}`);
  }
  writeGitHubOutputs({
    "verified-count": String(verified.length),
    "verified-result-root": results,
  });
  return { ok: true, verified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyArtifactSigningResults();
  } catch (error) {
    console.error(`::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  }
}
