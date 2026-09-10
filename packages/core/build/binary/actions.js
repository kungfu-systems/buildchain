import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { command } from "../../runtime/action-process.mjs";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import {
  admitBinaryDistribution,
  buildBinaryDistribution,
  qualifyBinaryDistribution,
} from "./distribution.js";
function sourceWorkspace(env) {
  const workspace = env.GITHUB_WORKSPACE;
  if (
    path.resolve(installationRoot(import.meta.url)) !==
      path.resolve(workspace) ||
    command("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      stdio: "pipe",
    }).trim() !== env.GITHUB_SHA
  )
    throw new Error("Binary distribution requires exact source-owned code");
  return workspace;
}
export function admitBinaryDistributionAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  admitBinaryDistribution({
    tag:
      env.GITHUB_EVENT_NAME === "workflow_dispatch"
        ? request.tag
        : env.GITHUB_REF_NAME,
    ref: env.GITHUB_REF,
    sourceSha: env.GITHUB_SHA,
  });
}
export async function buildBinaryDistributionAction(core, env) {
  const workspace = sourceWorkspace(env),
    matrix = JSON.parse(core.getInput("matrix-json", { required: true }));
  const nodePath = command("node", ["-p", "process.execPath"], {
    cwd: workspace,
    stdio: "pipe",
  }).trim();
  const nodeVersion = command(nodePath, ["--version"], {
    cwd: workspace,
    stdio: "pipe",
  }).trim();
  return buildBinaryDistribution({
    workspace,
    tag: core.getInput("tag", { required: true }),
    platform: matrix.platform,
    runner: matrix.os,
    nodePath,
    nodeVersion,
    logPath: env.BUILDCHAIN_LOG_PATH,
  });
}
export async function qualifyBinaryDistributionAction(core, env) {
  const workspace = sourceWorkspace(env);
  return qualifyBinaryDistribution({
    workspace,
    tag: core.getInput("tag", { required: true }),
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.GITHUB_SHA,
    logPath: env.BUILDCHAIN_LOG_PATH,
    client: releaseAssetClient(env.GITHUB_REPOSITORY, {
      token: core.getInput("token", { required: true }),
    }),
    workflow: {
      name: env.GITHUB_WORKFLOW || "",
      runId: env.GITHUB_RUN_ID || "",
      runAttempt: env.GITHUB_RUN_ATTEMPT || "",
      url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      runnerKind: "github-hosted",
      runnerOs: env.RUNNER_OS || process.platform,
      runnerArch: env.RUNNER_ARCH || process.arch,
      runnerImage: env.ImageOS || "",
    },
  });
}
