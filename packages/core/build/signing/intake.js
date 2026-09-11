import {
  required,
  safeSigningId,
  signingFilesNamed,
  signingFileDigest,
  resolveSigningPath,
  writeSigningResultIndex,
} from "./files.js";
import fs from "node:fs";
import path from "node:path";

import { validateArtifactSigningRequest } from "../artifact-signing.js";
import { artifactSigningRequestRoot } from "../signing/request.js";

export function inspectArtifactSigningRequests({
  inputRoot,
  expectedRepository,
  expectedRequestRoot,
} = {}) {
  const root = path.resolve(required(inputRoot, "signing request root"));
  const indexes = signingFilesNamed(root, "index.json");
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
      const requestPath = resolveSigningPath(
        root,
        path.relative(root, path.resolve(path.dirname(indexPath), entry.path)),
        "signing request path",
      );
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
      const key = `${request.source.sha}:${request.artifact.id}:${request.artifact.platform}`;
      if (seen.has(key))
        throw new Error(`duplicate artifact signing request: ${key}`);
      seen.add(key);
      const { entitlementsProfile = "none", entitlementsPaths = [] } =
        request.signature;
      const item = {
        id: request.artifact.id,
        slug: safeSigningId(request.artifact.id),
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
  return matrices;
}
