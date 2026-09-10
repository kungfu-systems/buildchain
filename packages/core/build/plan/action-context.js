import path from "node:path";
import { execFileSync } from "node:child_process";
import { installationRoot } from "../../runtime/installation-root.js";
import { bindBuildPlan } from "./identity.js";
export function readBuildActionContext(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const runtimeRoot = installationRoot(import.meta.url);
  const runtimeSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: runtimeRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const selected = core.getInput("platform");
  const context = bindBuildPlan({
    plan: JSON.parse(core.getInput("plan", { required: true })),
    platformId: selected ? JSON.parse(selected).id : "",
    workspace,
    runtimeSha,
    run: {
      repository: env.GITHUB_REPOSITORY,
      id: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    },
  });
  return {
    ...context,
    runtimeRoot,
    sourceRoot: path.join(workspace, "source"),
  };
}
