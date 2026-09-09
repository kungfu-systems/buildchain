import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildPublicationArtifactCandidate,
  resolvePublicationCandidateFile,
} from "../../publication/commands/publication-artifact-candidate.mjs";
import {
  createPublicationSealedBundle,
  verifyPublicationSealedBundle,
} from "../../publication/publication-sealed-bundle.js";

export function verifyAdmittedCandidate(env) {
  const root = ".buildchain/admitted/artifact";
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  const sourceTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  const actualRuntimeSha = execFileSync(
    "git",
    ["-C", ".buildchain/runtime", "rev-parse", "HEAD"],
    { encoding: "utf8" },
  )
    .trim()
    .toLowerCase();
  if (actualRuntimeSha !== env.BUILDCHAIN_RUNTIME_SHA)
    throw new Error("admitted paper runtime checkout mismatch");
  const bundle = buildPublicationArtifactCandidate({
    artifactRoot: root,
    controllerRoot: ".buildchain/admitted/controller",
    repository: env.GITHUB_REPOSITORY,
    sourceSha,
    sourceTreeSha,
    runtimeSha: env.BUILDCHAIN_RUNTIME_SHA,
  });
  const capability = JSON.parse(env.BUILDCHAIN_CAPABILITY_JSON);
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
    packageJson.name !== env.BUILDCHAIN_PACKAGE_NAME ||
    packageJson.version !== env.BUILDCHAIN_PACKAGE_VERSION ||
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
    githubReleaseRequired: env.BUILDCHAIN_GITHUB_RELEASE === "true",
  });
  verifyPublicationSealedBundle({ bundleRoot: root, manifest: sealedBundle });
  const sealedBundlePath = ".buildchain/admitted/sealed-bundle.json";
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
  const output = fs.createWriteStream(env.GITHUB_OUTPUT, { flags: "a" });
  output.write(`package-dir=${packageDir}\n`);
  output.write(`package-name=${packageJson.name}\n`);
  output.write(`package-version=${packageJson.version}\n`);
  output.write(`dist-tag=${env.BUILDCHAIN_DIST_TAG}\n`);
  output.write(`exact-tag=v${packageJson.version}\n`);
  output.write(`manifest-path=${manifestPath}\n`);
  output.write(`build-summary-path=${buildSummaryPath}\n`);
  output.write(`sealed-bundle-root=${path.resolve(root)}\n`);
  output.write(`sealed-bundle-manifest=${path.resolve(sealedBundlePath)}\n`);
  output.write(
    `required-artifacts-json=${JSON.stringify(JSON.parse(fs.readFileSync(requiredArtifactsPath, "utf8")))}\n`,
  );
  const marker = `EOF_ASSETS_${Date.now()}`;
  output.write(
    `github-release-artifact-paths<<${marker}\n${releaseAssets.join("\n")}\n${marker}\n`,
  );
  output.end();
}
