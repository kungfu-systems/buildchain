import {
  releaseCandidateRuntimeSha,
  resolveFreshPublicationVersion,
} from "./selection.js";
import {
  outputPath,
  findDownloadedFiles,
  findDownloadedFilesByExtension,
  selectReleaseAssetPaths,
  readNpmPackageArtifact,
  generatePublishRequiredArtifacts,
  findDownloadedFile,
  resolvePublicationEvidence,
} from "./payloads.js";
import { resolveCandidatePublicationBundle } from "../../publication/candidate/sealing.js";
import fs from "node:fs";
import path from "node:path";
export function materializeCandidateEvidence({
  result,
  resolvedOutput,
  passportDir,
  summaryDir,
  payloadDir,
  payloadArtifacts,
  minimumPayloadCount,
  publishArtifactKind,
  publishPackageMain,
  githubReleasePayloadPatterns,
}) {
  const passportPath = findDownloadedFile(
    passportDir,
    "release-candidate-passport.json",
  );
  const buildSummaryPath = findDownloadedFile(summaryDir, "build-summary.json");
  if (!passportPath || !buildSummaryPath) {
    throw new Error(
      "downloaded release-candidate artifacts did not contain release-candidate-passport.json and build-summary.json",
    );
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const domainPublication = resolvePublicationEvidence(
    passportDir,
    passport,
    outputPath,
  );
  const platformManifestPaths = findDownloadedFiles(
    payloadDir,
    "manifest.json",
  );
  const githubArtifactAttestationPolicyPaths = findDownloadedFiles(
    payloadDir,
    "github-artifact-attestation-policy.json",
  );
  const npmTarballPaths =
    publishArtifactKind === "npm"
      ? findDownloadedFilesByExtension(payloadDir, [".tgz"])
      : [];
  const releaseAssetPaths = selectReleaseAssetPaths({
    payloadRoot: payloadDir,
    patterns: githubReleasePayloadPatterns,
  });
  const downloadedRequiredArtifactCount =
    publishArtifactKind === "npm"
      ? npmTarballPaths.length
      : platformManifestPaths.length;
  if (
    minimumPayloadCount > 0 &&
    downloadedRequiredArtifactCount < minimumPayloadCount
  ) {
    const noun =
      publishArtifactKind === "npm"
        ? "npm package tarballs"
        : "platform manifests";
    throw new Error(
      `expected at least ${minimumPayloadCount} downloaded ${noun}, found ${downloadedRequiredArtifactCount}`,
    );
  }
  const sealedBundle = resolveCandidatePublicationBundle({
    kind: publishArtifactKind,
    payloadDir,
    passport,
    runtimeSha: releaseCandidateRuntimeSha(passport),
    releaseAssetPaths,
    npmArtifacts: npmTarballPaths.map((tarballPath) => ({
      path: tarballPath,
      ...readNpmPackageArtifact({
        tarballPath,
        mainPackage: publishPackageMain,
      }),
    })),
  });
  const manifests = platformManifestPaths.map((manifestPath) =>
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    ),
    publicationVersion = resolveFreshPublicationVersion({
      sealedBundle,
      candidateVersion: passport.target?.version,
    });
  const generatedRequiredArtifacts =
    sealedBundle?.requiredArtifacts ||
    generatePublishRequiredArtifacts({
      manifests,
      version: publicationVersion,
      kind: publishArtifactKind,
      tarballPaths: npmTarballPaths,
      mainPackage: publishPackageMain,
    });
  const requiredArtifactsPath = path.join(
    resolvedOutput,
    "publish-required-artifacts.json",
  );
  fs.writeFileSync(
    requiredArtifactsPath,
    `${JSON.stringify(generatedRequiredArtifacts, null, 2)}\n`,
  );
  const sealedBundleManifestPath = sealedBundle
    ? path.join(resolvedOutput, "sealed-bundle.json")
    : "";
  if (sealedBundleManifestPath) {
    fs.writeFileSync(
      sealedBundleManifestPath,
      `${JSON.stringify(sealedBundle.manifest, null, 2)}\n`,
    );
  }
  return {
    ...result,
    paths: {
      passport: outputPath(passportPath),
      buildSummary: outputPath(buildSummaryPath),
      ...domainPublication.paths,
      payloads: outputPath(payloadDir),
      platformManifests: platformManifestPaths.map(outputPath),
      githubArtifactAttestationPolicies:
        githubArtifactAttestationPolicyPaths.map(outputPath),
      npmTarballs: npmTarballPaths.map(outputPath),
      releaseAssets: releaseAssetPaths.map(outputPath),
      publishRequiredArtifacts: outputPath(requiredArtifactsPath),
      sealedBundleRoot: sealedBundle ? outputPath(sealedBundle.root) : "",
      sealedBundleManifest: sealedBundleManifestPath
        ? outputPath(sealedBundleManifestPath)
        : "",
    },
    version: passport.target?.version || "",
    publicationVersion,
    candidateHash: passport.candidateHash || "",
    payloadCount: payloadArtifacts.length,
    platformManifestCount: platformManifestPaths.length,
    githubArtifactAttestationPolicyCount:
      githubArtifactAttestationPolicyPaths.length,
    npmTarballCount: npmTarballPaths.length,
    publishRequiredArtifacts: generatedRequiredArtifacts,
    publicationQualificationRoot:
      domainPublication.publicationQualificationRoot,
  };
}
