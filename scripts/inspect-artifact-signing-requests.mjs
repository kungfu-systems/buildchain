#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { artifactSigningRequestRoot } from "./artifact-signing-controller-core.mjs";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function safeId(value) {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("unsafe signing request id");
  }
  return normalized;
}

function walk(root, name, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) walk(child, name, output);
    else if (entry.isFile() && entry.name === name) output.push(child);
  }
  return output;
}

export function inspectArtifactSigningRequests({
  inputRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT,
  expectedRepository = process.env.BUILDCHAIN_SIGNING_SOURCE_REPOSITORY,
  expectedRuntimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  expectedRequestRoot = process.env.BUILDCHAIN_SIGNING_EXPECTED_REQUEST_ROOT,
} = {}) {
  const root = path.resolve(required(inputRoot, "signing request root"));
  const indexes = walk(root, "index.json");
  if (indexes.length === 0)
    throw new Error("no artifact signing request indexes found");
  const seen = new Set();
  const observedRoots = [];
  const matrices = {
    detached: [],
    macos: [],
    windows: [],
  };
  for (const indexPath of indexes) {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (
      index.contract !== "kungfu-buildchain-artifact-signing-request-index/v1"
    )
      continue;
    observedRoots.push(artifactSigningRequestRoot(index));
    for (const entry of index.requests || []) {
      const requestPath = path.resolve(path.dirname(indexPath), entry.path);
      const relative = path.relative(root, requestPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          "signing request path escapes the authority intake root",
        );
      }
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      const check = validateArtifactSigningRequest(request);
      if (!check.ok || request.digest !== entry.digest) {
        throw new Error(`invalid artifact signing request: ${entry.id}`);
      }
      if (
        expectedRepository &&
        request.source.repository !== expectedRepository
      ) {
        throw new Error("signing request source repository mismatch");
      }
      if (expectedRuntimeSha && request.runtime.sha !== expectedRuntimeSha) {
        throw new Error("signing request runtime SHA mismatch");
      }
      const key = `${request.source.sha}:${request.artifact.id}:${request.artifact.platform}`;
      if (seen.has(key))
        throw new Error(`duplicate artifact signing request: ${key}`);
      seen.add(key);
      const {
        entitlementsProfile = "none",
        entitlementsPaths = [],
      } = request.signature;
      const item = {
        id: request.artifact.id,
        slug: safeId(request.artifact.id),
        request: path.relative(root, requestPath).split(path.sep).join("/"),
        directory: path
          .relative(root, path.dirname(requestPath))
          .split(path.sep)
          .join("/"),
        indexRoot:
          path
            .relative(root, path.dirname(indexPath))
            .split(path.sep)
            .join("/") || ".",
        kind: request.artifact.kind,
        platform: request.artifact.platform,
        arch: request.artifact.arch || "",
        platformId: [request.artifact.platform, request.artifact.arch]
          .filter(Boolean)
          .join("-"),
        sourceSha: request.source.sha,
        sourceTreeSha: request.source.treeSha,
        transportFormat: request.artifact.transport?.format || "",
        entitlementsProfile,
        entitlementsPaths: entitlementsPaths.join(","),
      };
      if (request.signature.profile === "detached-signature-v1")
        matrices.detached.push(item);
      else if (request.signature.profile === "apple-developer-id")
        matrices.macos.push(item);
      else if (request.signature.profile === "windows-authenticode")
        matrices.windows.push(item);
      else
        throw new Error(
          `unsupported signing authority profile: ${request.signature.profile}`,
        );
    }
  }
  if (expectedRequestRoot) {
    if (observedRoots.length !== 1) {
      throw new Error("signing authority expected exactly one request root");
    }
    if (observedRoots[0] !== expectedRequestRoot) {
      throw new Error("signing authority request root mismatch");
    }
  }
  for (const entries of Object.values(matrices))
    entries.sort((a, b) => a.request.localeCompare(b.request));
  writeGitHubOutputs({
    "detached-matrix": JSON.stringify(matrices.detached),
    "macos-matrix": JSON.stringify(matrices.macos),
    "windows-matrix": JSON.stringify(matrices.windows),
    "request-count": String(seen.size),
  });
  return matrices;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    inspectArtifactSigningRequests();
  } catch (error) {
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
