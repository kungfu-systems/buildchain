import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildPublicationArtifactCandidate } from "../../publication/candidate/artifact.js";
import { resolvePublicationCandidateFile } from "../../publication/publication-artifact-candidate.js";
import {
  createPublicationSealedBundle,
  verifyPublicationSealedBundle,
} from "../../publication/publication-sealed-bundle.js";

export function verifyAdmittedCandidate({
  workspace,
  runtimeRoot,
  repository,
  runtimeSha,
  capability,
  packageName,
  packageVersion,
  distTag,
  githubRelease,
}) {
  const root = path.join(workspace, ".buildchain/admitted/artifact");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd: workspace,
  })
    .trim()
    .toLowerCase();
  const sourceTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
    cwd: workspace,
  })
    .trim()
    .toLowerCase();
  const bundle = buildPublicationArtifactCandidate({
    artifactRoot: root,
    controllerRoot: path.join(workspace, ".buildchain/admitted/controller"),
    repository: repository,
    sourceSha,
    sourceTreeSha,
    runtimeSha: runtimeSha,
  });
  if (
    capability.decision !== "allow" ||
    capability.artifactDigest !== bundle.candidate.candidateDigest
  ) {
    throw new Error(
      "downloaded publication candidate does not match the sealed publication capability",
    );
  }
  const exactPath = (candidatePath) =>
    path.resolve(
      root,
      resolvePublicationCandidateFile(bundle.evidence.files, candidatePath),
    );
  const packageJsonPath = exactPath(
    ".buildchain/publication/npm-package/package.json",
  );
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (
    packageJson.name !== packageName ||
    packageJson.version !== packageVersion ||
    packageJson.gitHead !== sourceSha
  ) {
    throw new Error(
      "prepared npm package identity or gitHead differs from the admitted publication plan",
    );
  }
  const manifestPath = exactPath(
    ".buildchain/publication/publication-artifact.json",
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const releaseAssets = (manifest.artifacts || []).map((entry) =>
    exactPath(entry.path),
  );
  const reproducibilityPath = exactPath(
    ".buildchain/publication/reproducibility-receipt.json",
  );
  const reproducibility = JSON.parse(
    fs.readFileSync(reproducibilityPath, "utf8"),
  );
  const qualifiedNpm = reproducibility.builds?.[0]?.npmPackage;
  if (!qualifiedNpm?.filename || !qualifiedNpm?.integrity) {
    throw new Error(
      "qualified reproducibility receipt is missing npm tarball identity",
    );
  }
  const npmTarballCandidatePath = `.buildchain/publication/npm-tarball/${qualifiedNpm.filename}`;
  exactPath(npmTarballCandidatePath);
  const sealedBundle = createPublicationSealedBundle({
    candidate: bundle.candidate,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    npmTarballPath: npmTarballCandidatePath,
    npmIntegrity: qualifiedNpm.integrity,
    releaseAssetPaths: (manifest.artifacts || []).map((entry) => entry.path),
    githubReleaseRequired: githubRelease === true,
  });
  verifyPublicationSealedBundle({ bundleRoot: root, manifest: sealedBundle });
  const sealedBundlePath = path.join(
    workspace,
    ".buildchain/admitted/sealed-bundle.json",
  );
  fs.mkdirSync(path.dirname(sealedBundlePath), { recursive: true });
  fs.writeFileSync(
    sealedBundlePath,
    `${JSON.stringify(sealedBundle, null, 2)}\n`,
  );
  const requiredArtifactsPath = exactPath(
    ".buildchain/paper-release/publish-required-artifacts.json",
  );
  const buildSummaryPath = exactPath(
    ".buildchain/paper-release/build-summary.json",
  );
  return {
    "package-dir": packageDir,
    "package-name": packageJson.name,
    "package-version": packageJson.version,
    "dist-tag": distTag,
    "exact-tag": `v${packageJson.version}`,
    "manifest-path": manifestPath,
    "build-summary-path": buildSummaryPath,
    "sealed-bundle-root": root,
    "sealed-bundle-manifest": sealedBundlePath,
    "required-artifacts-json": JSON.stringify(
      JSON.parse(fs.readFileSync(requiredArtifactsPath, "utf8")),
    ),
    "github-release-artifact-paths": releaseAssets.join("\n"),
  };
}
