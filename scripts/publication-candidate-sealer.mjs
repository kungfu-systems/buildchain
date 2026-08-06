import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} from "../packages/core/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../packages/core/publication-sealed-bundle.js";

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function normalizeSha256(value, label) {
  const digest = requiredString(value, label).replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} must be a sha256 digest`);
  return digest;
}

function assertGitSha(value, label) {
  const sha = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${label} must be a 40-character Git SHA`);
  return sha.toLowerCase();
}

function collectCandidateFiles(root) {
  const resolvedRoot = path.resolve(requiredString(root, "bundleRoot"));
  const files = [];
  const stack = fs.existsSync(resolvedRoot) ? [resolvedRoot] : [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          path: path.relative(resolvedRoot, absolutePath).split(path.sep).join("/"),
          absolutePath,
          size: fs.statSync(absolutePath).size,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
        });
      }
    }
  }
  return { resolvedRoot, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

export function createResolvedPublicationSealedBundle({
  bundleRoot,
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
  releaseCandidateRoot,
  npmArtifacts = [],
  releaseAssetPaths = [],
} = {}) {
  if (npmArtifacts.length === 0) return undefined;
  const { resolvedRoot, files } = collectCandidateFiles(bundleRoot);
  const byAbsolutePath = new Map(files.map((file) => [path.resolve(file.absolutePath), file]));
  const resolvedNpmArtifacts = npmArtifacts.map((artifact, index) => {
    const file = byAbsolutePath.get(path.resolve(requiredString(artifact.path, `npmArtifacts[${index}].path`)));
    if (!file) throw new Error(`npmArtifacts[${index}].path is outside the sealed payload root`);
    return { file, metadata: artifact };
  });
  const main = resolvedNpmArtifacts.find((entry) => entry.metadata.role === "main")
    || (resolvedNpmArtifacts.length === 1 ? resolvedNpmArtifacts[0] : undefined);
  if (!main) throw new Error("candidate npm payload set has no unique main package tarball");
  const selectedReleaseAssets = (releaseAssetPaths.length > 0
    ? releaseAssetPaths
    : resolvedNpmArtifacts.map((entry) => entry.file.absolutePath))
    .map((assetPath, index) => {
      const file = byAbsolutePath.get(path.resolve(assetPath));
      if (!file) throw new Error(`releaseAssetPaths[${index}] is outside the sealed payload root`);
      return file;
    });
  const candidatePayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: requiredString(repository, "repository"),
    sourceSha: assertGitSha(sourceSha, "sourceSha"),
    sourceTreeSha: assertGitSha(sourceTreeSha, "sourceTreeSha"),
    runtimeSha: assertGitSha(runtimeSha, "runtimeSha"),
    releaseCandidateRoot: `sha256:${normalizeSha256(releaseCandidateRoot, "releaseCandidateRoot")}`,
    files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: publicationArtifactCandidateDigest(candidatePayload),
  };
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: main.metadata.name,
    packageVersion: main.metadata.ref,
    npmTarballPath: main.file.path,
    npmIntegrity: main.metadata.integrity,
    releaseAssetPaths: selectedReleaseAssets.map((file) => file.path),
  });
  return { root: resolvedRoot, manifest, npmArtifacts: resolvedNpmArtifacts, files };
}
