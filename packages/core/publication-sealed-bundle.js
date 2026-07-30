import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "./publication-artifact-candidate.js";

export const PUBLICATION_SEALED_BUNDLE_CONTRACT = "kungfu-buildchain-publication-sealed-bundle";

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function safeRelativePath(value, label) {
  const normalized = requiredString(value, label).replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function normalizeSha256(value, label) {
  const normalized = requiredString(value, label)
    .replace(/^sha256:/, "")
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizeFile(entry, label) {
  const size = Number(entry?.size ?? entry?.bytes);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label}.size must be a non-negative safe integer`);
  }
  return {
    path: safeRelativePath(entry.path, `${label}.path`),
    size,
    sha256: normalizeSha256(entry.sha256, `${label}.sha256`),
  };
}

function candidatePayload(candidate) {
  if (candidate?.contract !== PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT || Number(candidate?.schemaVersion) !== 1) {
    throw new Error("publication artifact candidate contract mismatch");
  }
  const { candidateDigest: _candidateDigest, ...payload } = candidate;
  const digest = publicationArtifactCandidateDigest(payload);
  if (normalizeSha256(candidate.candidateDigest, "candidate.candidateDigest") !== digest) {
    throw new Error("publication artifact candidate digest mismatch");
  }
  return { payload, digest };
}

function selectFile(files, filePath, label) {
  const normalizedPath = safeRelativePath(filePath, label);
  const matches = files.filter((entry) => entry.path === normalizedPath);
  if (matches.length !== 1) {
    throw new Error(`${label} must identify exactly one candidate file`);
  }
  return matches[0];
}

export function createPublicationSealedBundle({
  candidate,
  packageName,
  packageVersion,
  npmTarballPath,
  npmIntegrity,
  releaseAssetPaths = [],
  githubReleaseRequired = true,
} = {}) {
  const { digest } = candidatePayload(candidate);
  const files = (candidate.files || [])
    .map((entry, index) => normalizeFile(entry, `candidate.files[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error("publication sealed bundle candidate paths must be unique");
  }
  const npmTarball = selectFile(files, npmTarballPath, "npmTarballPath");
  const releaseAssets = [...new Set(releaseAssetPaths)]
    .map((assetPath, index) => selectFile(files, assetPath, `releaseAssetPaths[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (releaseAssets.length === 0) {
    throw new Error("publication sealed bundle requires at least one release asset");
  }
  const normalizedVersion = requiredString(packageVersion, "packageVersion");
  return {
    schemaVersion: 1,
    contract: PUBLICATION_SEALED_BUNDLE_CONTRACT,
    root: `sha256:${digest}`,
    candidate,
    files,
    npm: {
      name: requiredString(packageName, "packageName"),
      version: normalizedVersion,
      path: npmTarball.path,
      size: npmTarball.size,
      sha256: npmTarball.sha256,
      integrity: requiredString(npmIntegrity, "npmIntegrity"),
    },
    releaseAssets,
    completion: {
      githubReleaseRequired: Boolean(githubReleaseRequired),
    },
    durablePath: `sealed-bundle/sha256/${digest}`,
    resumeCommand:
      `buildchain paper resume --version ${JSON.stringify(normalizedVersion)} ` +
      `--state-ref ${JSON.stringify(`refs/heads/buildchain/release-state/${normalizedVersion.replaceAll(".", "-")}`)}`,
  };
}

export function verifyPublicationSealedBundle({ bundleRoot, manifest } = {}) {
  if (manifest?.contract !== PUBLICATION_SEALED_BUNDLE_CONTRACT || Number(manifest?.schemaVersion) !== 1) {
    throw new Error("publication sealed bundle contract mismatch");
  }
  const resolvedRoot = path.resolve(requiredString(bundleRoot, "bundleRoot"));
  const { digest } = candidatePayload(manifest.candidate);
  if (normalizeSha256(manifest.root, "manifest.root") !== digest) {
    throw new Error("publication sealed bundle root mismatch");
  }
  const files = (manifest.files || [])
    .map((entry, index) => normalizeFile(entry, `manifest.files[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
  const candidateFiles = (manifest.candidate.files || [])
    .map((entry, index) => normalizeFile(entry, `candidate.files[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(files) !== JSON.stringify(candidateFiles)) {
    throw new Error("publication sealed bundle file inventory differs from candidate");
  }
  for (const [index, entry] of files.entries()) {
    const filePath = path.resolve(resolvedRoot, entry.path);
    if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`manifest.files[${index}].path escapes bundle root`);
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`publication sealed bundle file is missing: ${entry.path}`);
    }
    const size = fs.statSync(filePath).size;
    const digestValue = sha256File(filePath);
    if (size !== entry.size || digestValue !== entry.sha256) {
      throw new Error(`publication sealed bundle file mismatch: ${entry.path}`);
    }
  }
  const npmFile = selectFile(files, manifest.npm?.path, "manifest.npm.path");
  if (
    npmFile.size !== Number(manifest.npm?.size) ||
    npmFile.sha256 !== normalizeSha256(manifest.npm?.sha256, "manifest.npm.sha256")
  ) {
    throw new Error("publication sealed bundle npm tarball inventory mismatch");
  }
  const releaseAssets = (manifest.releaseAssets || []).map((entry, index) => {
    const selected = selectFile(files, entry.path, `manifest.releaseAssets[${index}].path`);
    const normalized = normalizeFile(entry, `manifest.releaseAssets[${index}]`);
    if (selected.size !== normalized.size || selected.sha256 !== normalized.sha256) {
      throw new Error(`publication sealed bundle release asset mismatch: ${entry.path}`);
    }
    return selected;
  });
  if (releaseAssets.length === 0) {
    throw new Error("publication sealed bundle requires at least one release asset");
  }
  return {
    ok: true,
    root: `sha256:${digest}`,
    bundleRoot: resolvedRoot,
    files,
    npm: {
      ...manifest.npm,
      path: npmFile.path,
      absolutePath: path.resolve(resolvedRoot, npmFile.path),
    },
    releaseAssets: releaseAssets.map((entry) => ({
      ...entry,
      absolutePath: path.resolve(resolvedRoot, entry.path),
    })),
    manifest,
  };
}
