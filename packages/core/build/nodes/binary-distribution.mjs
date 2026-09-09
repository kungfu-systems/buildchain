import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireValue, runOperation } from "../../runtime/action-process.mjs";
import { createBuildchainLogger } from "../../observability/logging.js";
import { writeChecksums } from "../../release/nodes/binary-assets.mjs";

export function binaryDistributionPreflight(env) {
  requireValue(
    /^v4\.\d+\.\d+(?:-alpha\.\d+)?$/.test(env.RELEASE_TAG || ""),
    "Binary distribution requires a current v4 release tag",
  );
  requireValue(
    env.GITHUB_REF === `refs/tags/${env.RELEASE_TAG}`,
    "Dispatch Binary Distribution at the exact release tag",
  );
  requireValue(
    /^[0-9a-f]{40}$/.test(env.GITHUB_SHA || ""),
    "Binary distribution requires an exact source SHA",
  );
}
export function binaryPassportOptions(
  env,
  read = (file) => JSON.parse(fs.readFileSync(file, "utf8")),
) {
  const evidence = ".buildchain/publication-evidence";
  const release = read(`${evidence}/release.json`);
  requireValue(
    release.publishedVersion ===
      String(env.RELEASE_TAG || "").replace(/^v/, ""),
    "Binary passport version must match the publication settlement",
  );
  return {
    tag: env.RELEASE_TAG,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.SOURCE_SHA,
    assetsDir: "dist/binary",
    outputDir: ".buildchain/release-passport",
    releaseEvidenceJsons: [
      `${evidence}/buildchain-publication-settlement.json`,
    ],
    releaseJsonExtra: `${evidence}/release.json`,
    packageVersion: release.publishedVersion,
    workflow: {
      name: env.GITHUB_WORKFLOW || "",
      runId: env.GITHUB_RUN_ID || "",
      runAttempt: env.GITHUB_RUN_ATTEMPT || "",
      url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      runnerKind: env.BUILDCHAIN_RUNNER_KIND || "github-hosted",
      runnerOs: env.RUNNER_OS || process.platform,
      runnerArch: env.RUNNER_ARCH || process.arch,
      runnerImage: env.ImageOS || "",
    },
  };
}
function logger(env) {
  return createBuildchainLogger({
    cwd: process.cwd(),
    path: env.BUILDCHAIN_LOG_PATH,
    source: "buildchain",
    component: "workflow",
    phase: "passport",
    console: true,
  });
}
export async function collectBinaryPassport(env) {
  const options = binaryPassportOptions(env);
  const { collectGitHubReleasePassport } = await import(
    pathToFileURL(path.resolve("packages/core/release/release-passport.js"))
      .href
  );
  return logger(env).span("release-passport.collect", {}, () => {
    const result = collectGitHubReleasePassport(options);
    console.log(
      `release passport collected: ${path.relative(process.cwd(), result.outputDir)}`,
    );
    console.log(`artifacts: ${result.artifactEvidence.artifacts.length}`);
    return result;
  });
}
export async function checksumBinaryArtifacts(env) {
  return logger(env).span("release-passport.checksums", {}, () =>
    writeChecksums("dist/binary"),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runOperation({
    preflight: binaryDistributionPreflight,
    collect: collectBinaryPassport,
    checksums: checksumBinaryArtifacts,
  });
}
