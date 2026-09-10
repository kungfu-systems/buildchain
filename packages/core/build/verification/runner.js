import { verifyRepository } from "./repository.js";
import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { collectGitHubReleasePassport } from "../../release/passport/collection.js";
import { verifyReleasePassport } from "../../release/release-passport.js";

export async function qualifyRunnerCompatibility(
  { workspace, repository, sourceSha, workflow, env },
  {
    execute = command,
    collect = collectGitHubReleasePassport,
    verify = verifyReleasePassport,
  } = {},
) {
  verifyRepository({ workspace, env }, execute);
  const assetsDir = path.join(workspace, "dist/passport-fixture"),
    outputDir = path.join(workspace, ".buildchain/self-hosted-passport");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(
    path.join(assetsDir, "buildchain-self-hosted-fixture.tar.gz"),
    "self-hosted compatibility fixture\n",
  );
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(workspace, "package.json"), "utf8"),
  ).version;
  const collection = collect({
    cwd: workspace,
    tag: "v0.0.0-self-hosted-smoke",
    repository,
    sourceSha,
    assetsDir,
    outputDir,
    packageVersion,
    workflow: { ...workflow, runnerKind: "self-hosted" },
  });
  if (!collection.checkReport.ok)
    throw new Error("Runner compatibility passport collection did not qualify");
  const report = await verify({
    passportLocation: path.join(outputDir, "buildchain.release.json"),
  });
  if (!report.ok)
    throw new Error("Runner compatibility passport verification failed");
  return report;
}
export async function qualifyRunnerCompatibilityAction(core, env) {
  const workspace = env.GITHUB_WORKSPACE;
  if (
    path.resolve(installationRoot(import.meta.url)) !== path.resolve(workspace)
  )
    throw new Error("Runner compatibility requires source-owned code");
  core.info(`Runner ${env.RUNNER_NAME}: ${env.RUNNER_OS}/${env.RUNNER_ARCH}`);
  return qualifyRunnerCompatibility({
    workspace,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    env,
    workflow: {
      name: env.GITHUB_WORKFLOW || "",
      runId: env.GITHUB_RUN_ID || "",
      runAttempt: env.GITHUB_RUN_ATTEMPT || "",
      url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      runnerOs: env.RUNNER_OS || process.platform,
      runnerArch: env.RUNNER_ARCH || process.arch,
      runnerImage: env.ImageOS || "",
    },
  });
}
