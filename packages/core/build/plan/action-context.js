import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { bindBuildPlan } from "./identity.js";
export function readBuildActionContext(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const runtimeRoot = installationRoot(import.meta.url);
  const selected = core.getInput("platform");
  const context = bindBuildPlan({
    plan: JSON.parse(core.getInput("plan", { required: true })),
    platformId: selected ? JSON.parse(selected).id : "",
    workspace,
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
