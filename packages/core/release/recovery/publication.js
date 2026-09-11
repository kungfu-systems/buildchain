import path from "node:path";
import { resolveOciCandidate } from "../../publication/candidate/kind.js";
import { resolveRecoveredPublicationVersion } from "../../publication/candidate/kind.js";
import { resolveRecoveredCandidateVersion } from "../../publication/candidate/kind.js";
import { generatePublishRequiredArtifacts } from "../candidate/payloads.js";
import { readNpmPackageArtifact } from "../candidate/payloads.js";
import { PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT } from "../../publication/publication-artifact-candidate.js";
import { publicationArtifactCandidateDigest } from "../../publication/publication-artifact-candidate.js";
import { createPublicationSealedBundle } from "../../publication/publication-sealed-bundle.js";
import { splitPatterns } from "../candidate/payloads.js";
import { artifactPatternToRegExp as patternMatcher } from "../candidate/payloads.js";
export function createRecoveredPublicationCandidate({
  allFiles,
  repository,
  passport,
}) {
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository,
    sourceSha: passport.source.headSha,
    sourceTreeSha: passport.source.treeHash,
    runtimeSha: passport.buildchain?.sha,
    releaseCandidateRoot: `sha256:${passport.candidateHash}`,
    files: allFiles.map(({ path: filePath, size, sha256 }) => ({
      path: filePath,
      size,
      sha256,
    })),
  };
  return {
    ...payload,
    candidateDigest: publicationArtifactCandidateDigest(payload),
  };
}

export function createRecoveredPublication({
  downloads,
  bundleRoot,
  repository,
  passport,
  publishArtifactKind,
  publishPackageMain,
  releasePatterns,
  platformManifests,
  channel,
  targetRef = "",
  candidateRef = "",
  rematerializeOnResume = false,
}) {
  const allFiles = downloads
    .flatMap((download) =>
      download.files.map((file) => ({
        path: path
          .relative(bundleRoot, file.absolutePath)
          .split(path.sep)
          .join("/"),
        size: file.size,
        sha256: file.sha256.replace(/^sha256:/, ""),
        absolutePath: file.absolutePath,
      })),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const kind = String(publishArtifactKind || "npm");
  const releaseMatchers = splitPatterns(releasePatterns).map(patternMatcher);
  const releaseAssets = allFiles.filter((file) =>
    releaseMatchers.some((matcher) => matcher.test(path.basename(file.path))),
  );
  if (kind === "oci") {
    createRecoveredPublicationCandidate({
      allFiles,
      repository,
      passport,
        });
    const sealed = resolveOciCandidate({ payloadRoot: bundleRoot, passport });
    return {
      manifest: sealed.manifest,
      bundleRoot: sealed.root,
      npmArtifacts: [],
      allFiles,
      releaseAssets,
      version: sealed.manifest.version,
      candidateVersion: sealed.manifest.version,
      publishRequiredArtifacts: sealed.requiredArtifacts,
    };
  }
  if (kind !== "npm") {
    createRecoveredPublicationCandidate({
      allFiles,
      repository,
      passport,
        });
    const version = String(passport.target?.version || "").trim();
    if (!version)
      throw new Error(
        "candidate recovery requires a passport publication version",
      );
    return {
      manifest: undefined,
      npmArtifacts: [],
      allFiles,
      releaseAssets,
      version,
      candidateVersion: version,
      publishRequiredArtifacts: generatePublishRequiredArtifacts({
        manifests: platformManifests,
        version,
        kind,
      }),
    };
  }
  const tarballs = allFiles.filter((file) =>
    file.path.toLowerCase().endsWith(".tgz"),
  );
  if (tarballs.length === 0)
    throw new Error(
      "candidate recovery for npm publication requires at least one exact .tgz payload artifact",
    );
  const npmArtifacts = tarballs.map((file) => ({
    file,
    metadata: readNpmPackageArtifact({
      tarballPath: file.absolutePath,
      mainPackage: publishPackageMain,
    }),
  }));
  const main =
    npmArtifacts.find((entry) => entry.metadata.role === "main") ||
    (npmArtifacts.length === 1 ? npmArtifacts[0] : undefined);
  if (!main)
    throw new Error(
      "candidate npm payload set has no unique main package tarball",
    );
  const npmReleaseAssets = allFiles.filter((file) =>
    releaseMatchers.length
      ? releaseMatchers.some((matcher) =>
          matcher.test(path.basename(file.path)),
        )
      : file.path.toLowerCase().endsWith(".tgz"),
  );
  const publicationVersion = resolveRecoveredPublicationVersion({
    artifactVersion: main.metadata.ref,
    channel,
    rematerializeOnResume,
  });
  const candidateVersion = resolveRecoveredCandidateVersion({
    artifactVersion: main.metadata.ref,
    publicationVersion,
    channel,
    rematerializeOnResume,
    targetRef,
    candidateRef,
  });
  const candidate = createRecoveredPublicationCandidate({
    allFiles,
    repository,
    passport,
    });
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: main.metadata.name,
    packageVersion: main.metadata.ref,
    npmTarballPath: main.file.path,
    npmIntegrity: main.metadata.integrity,
    releaseAssetPaths: npmReleaseAssets.map((file) => file.path),
  });
  return {
    manifest,
    npmArtifacts,
    allFiles,
    releaseAssets: npmReleaseAssets,
    version: publicationVersion,
    candidateVersion,
    publishRequiredArtifacts: generatePublishRequiredArtifacts({
      kind: "npm",
      tarballPaths: npmArtifacts.map((entry) => entry.file.absolutePath),
      mainPackage: publishPackageMain,
    }).map((artifact) =>
      rematerializeOnResume
        ? { ...artifact, ref: publicationVersion }
        : artifact,
    ),
  };
}
