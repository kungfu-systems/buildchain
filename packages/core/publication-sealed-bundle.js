import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
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
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
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

function fileInventory(files, label) {
  return (files || []).map((entry, index) => normalizeFile(entry, `${label}[${index}]`))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function candidatePayload(candidate) {
  if (
    candidate?.contract !== PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT ||
    Number(candidate?.schemaVersion) !== 1
  ) {
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
  const files = fileInventory(candidate.files, "candidate.files");
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
    ...(candidate.npmPackages ? { npmPackages: candidate.npmPackages } : {}),
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

function verifyNpmPackageSet(manifest, files, resolvedRoot) {
  const npmPackages = manifest.npmPackages;
  if (JSON.stringify(npmPackages) !== JSON.stringify(manifest.candidate.npmPackages)) {
    throw new Error("publication sealed bundle npm package inventory differs from candidate");
  }
  if (npmPackages) {
    if (
      !Array.isArray(npmPackages) ||
      npmPackages.length < 2 ||
      new Set(npmPackages.map((entry) => entry.name)).size !== npmPackages.length ||
      new Set(npmPackages.map((entry) => entry.path)).size !== npmPackages.length
    ) {
      throw new Error("publication sealed bundle npm package inventory must be unique");
    }
    for (const entry of npmPackages) {
      const file = selectFile(files, entry.path, "npmPackages.path");
      const absolutePath = path.resolve(resolvedRoot, file.path);
      const metadata = JSON.parse(
        execFileSync("tar", ["-xOf", path.basename(absolutePath), "package/package.json"], {
          cwd: path.dirname(absolutePath),
          encoding: "utf8",
        }),
      );
      const integrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(absolutePath)).digest("base64")}`;
      if (
        entry.name !== metadata.name ||
        entry.version !== metadata.version ||
        entry.size !== file.size ||
        entry.sha256 !== file.sha256 ||
        entry.integrity !== integrity
      ) {
        throw new Error("publication sealed bundle npm package identity or integrity mismatch");
      }
    }
    const main = npmPackages.filter((entry) => entry.role === "main");
    if (
      main.length !== 1 ||
      Object.keys(manifest.npm).some((key) => main[0][key] !== manifest.npm[key])
    ) {
      throw new Error("publication sealed bundle npm main package mismatch");
    }
  }
  return npmPackages;
}

export function verifyPublicationSealedBundle({ bundleRoot, manifest } = {}) {
  if (
    manifest?.contract !== PUBLICATION_SEALED_BUNDLE_CONTRACT ||
    Number(manifest?.schemaVersion) !== 1
  ) {
    throw new Error("publication sealed bundle contract mismatch");
  }
  const resolvedRoot = path.resolve(requiredString(bundleRoot, "bundleRoot"));
  const { digest } = candidatePayload(manifest.candidate);
  if (normalizeSha256(manifest.root, "manifest.root") !== digest) {
    throw new Error("publication sealed bundle root mismatch");
  }
  const files = fileInventory(manifest.files, "manifest.files");
  const candidateFiles = fileInventory(manifest.candidate.files, "candidate.files");
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
  const npmPackages = verifyNpmPackageSet(manifest, files, resolvedRoot);
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
    ...(npmPackages
      ? {
          npmPackages: npmPackages.map((entry) => ({
            ...entry,
            absolutePath: path.resolve(resolvedRoot, entry.path),
          })),
        }
      : {}),
    manifest,
  };
}
