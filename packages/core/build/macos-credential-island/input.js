import fs from "node:fs";
import path from "node:path";
import { validateArtifactSigningRequest } from "../artifact-signing.js";
import {
  INPUT_CONTRACT,
  SHA256_PATTERN,
  requireRepository,
  requireSha,
  requirePattern,
  resolveInside,
  assertRealPathInside,
  sha256File,
} from "./lib.js";

export function loadCredentialInput(inputRoot, expected = {}) {
  const manifests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "credential-input.json")
        manifests.push(target);
    }
  };
  visit(path.resolve(inputRoot));
  if (manifests.length !== 1) {
    throw new Error(
      `expected one credential-input.json under input-root, found ${manifests.length}`,
    );
  }
  const manifestPath = manifests[0];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== INPUT_CONTRACT)
    throw new Error(`credential input must use ${INPUT_CONTRACT}`);
  const repository = requireRepository(manifest.source?.repository);
  const sourceSha = requireSha(
    manifest.source?.sha,
    "credential input source SHA",
  );
  const sourceTreeSha = requireSha(
    manifest.source?.treeSha,
    "credential input source tree SHA",
  );
  if (expected.repository && repository !== expected.repository)
    throw new Error("credential input repository mismatch");
  if (expected.sourceSha && sourceSha !== expected.sourceSha)
    throw new Error("credential input source SHA mismatch");
  if (expected.sourceTreeSha && sourceTreeSha !== expected.sourceTreeSha)
    throw new Error("credential input source tree SHA mismatch");
  if (manifest.platform?.os !== "macos")
    throw new Error("credential input platform must be macos");
  if (!["arm64", "x64"].includes(manifest.platform?.arch))
    throw new Error("credential input architecture is unsupported");
  if (
    !manifest.app?.bundleId ||
    !manifest.app?.productName ||
    !manifest.app?.version
  ) {
    throw new Error("credential input app identity is incomplete");
  }
  if (expected.bundleId && manifest.app.bundleId !== expected.bundleId) {
    throw new Error("credential input bundle identifier mismatch");
  }
  const archivePath = resolveInside(
    path.dirname(manifestPath),
    manifest.archive?.file,
    "credential input archive",
  );
  if (!fs.statSync(archivePath).isFile())
    throw new Error("credential input archive is not a file");
  assertRealPathInside(
    path.dirname(manifestPath),
    archivePath,
    "credential input archive",
  );
  const expectedDigest = requirePattern(
    manifest.archive?.sha256,
    SHA256_PATTERN,
    "credential input archive digest",
  ).toLowerCase();
  if (sha256File(archivePath) !== expectedDigest)
    throw new Error("credential input archive digest mismatch");
  if (Number(manifest.archive?.bytes) !== fs.statSync(archivePath).size)
    throw new Error("credential input archive size mismatch");
  return { manifest, manifestPath, archivePath };
}

export function loadArtifactSigningInput(inputRoot, expected = {}) {
  const requests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === "request.json")
        requests.push(target);
    }
  };
  const root = path.resolve(inputRoot);
  visit(root);
  const candidates = requests
    .map((requestPath) => ({
      requestPath,
      request: JSON.parse(fs.readFileSync(requestPath, "utf8")),
    }))
    .filter(
      ({ request }) =>
        request.signature?.profile === "apple-developer-id" &&
        (!expected.artifactId || request.artifact?.id === expected.artifactId),
    );
  if (candidates.length !== 1) {
    throw new Error(
      `expected one matching apple-developer-id request.json under input-root, found ${candidates.length}`,
    );
  }
  const { requestPath, request } = candidates[0];
  const check = validateArtifactSigningRequest(request);
  if (!check.ok) {
    throw new Error(
      `artifact signing request is invalid: ${check.issues.join(", ")}`,
    );
  }
  if (request.artifact.platform !== "macos") {
    throw new Error("artifact signing request platform must be macos");
  }
  if (request.artifact.kind !== "app-bundle") {
    throw new Error(
      `apple authority adapter does not yet support ${request.artifact.kind}; expected app-bundle`,
    );
  }
  const repository = requireRepository(request.source.repository);
  const sourceSha = requireSha(
    request.source.sha,
    "artifact signing source SHA",
  );
  const sourceTreeSha = requireSha(
    request.source.treeSha,
    "artifact signing source tree SHA",
  );
  const runtimeSha = request.runtime.sha;
  if (expected.repository && repository !== expected.repository)
    throw new Error("artifact signing request repository mismatch");
  if (expected.sourceSha && sourceSha !== expected.sourceSha)
    throw new Error("artifact signing request source SHA mismatch");
  if (expected.sourceTreeSha && sourceTreeSha !== expected.sourceTreeSha)
    throw new Error("artifact signing request source tree SHA mismatch");

  const transport = request.artifact.transport;
  if (transport?.format !== "ditto-zip") {
    throw new Error("apple app signing request must use ditto-zip transport");
  }
  const archivePath = resolveInside(
    path.dirname(path.dirname(requestPath)),
    transport.file,
    "artifact signing transport",
  );
  if (!fs.statSync(archivePath).isFile()) {
    throw new Error("artifact signing transport is not a file");
  }
  assertRealPathInside(root, archivePath, "artifact signing transport");
  if (sha256File(archivePath) !== transport.digest) {
    throw new Error("artifact signing transport digest mismatch");
  }
  if (fs.statSync(archivePath).size !== transport.bytes) {
    throw new Error("artifact signing transport size mismatch");
  }
  const archivePathInPayload = path.basename(request.artifact.path);
  return {
    request,
    requestPath,
    manifestPath: requestPath,
    archivePath,
    manifest: {
      schema: request.contract,
      source: request.source,
      platform: {
        id: String(expected.platformId || "macos"),
        os: "macos",
        arch: request.artifact.arch,
      },
      app: {
        archivePath: archivePathInPayload,
        productName: archivePathInPayload.replace(/\.app$/iu, ""),
        ...(request.artifact.bundleId
          ? { bundleId: request.artifact.bundleId }
          : {}),
      },
      archive: {
        file: transport.file,
        format: transport.format,
        bytes: transport.bytes,
        sha256: transport.digest,
      },
    },
  };
}

export function loadMacosSigningInput(inputRoot, expected = {}) {
  try {
    return loadArtifactSigningInput(inputRoot, expected);
  } catch (genericError) {
    try {
      return loadCredentialInput(inputRoot, expected);
    } catch (legacyError) {
      throw new Error(
        `macOS signing input is neither a generic artifact request nor a legacy credential input: ${genericError.message}; ${legacyError.message}`,
      );
    }
  }
}
