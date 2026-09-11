import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
export function demoActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const sha = env.BUILDCHAIN_RUNTIME_SHA;

  return {
    workspace,
    runtimeRoot,
    runtimeSha: sha,
    sourceSha: core.getInput("source-sha", { required: true }),
    rendererImage: core.getInput("renderer-image", { required: true }),
    mediaProfile: core.getInput("media-profile") || "archive-v1",
  };
}
