import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
export function demoActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const sha = core.getInput("runtime-sha", { required: true });
  if (
    !/^[a-f0-9]{40}$/u.test(sha) ||
    command("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
      stdio: "pipe",
    }).trim() !== sha
  )
    throw new Error(
      "Demo runtime differs from the exact workflow implementation",
    );
  return {
    workspace,
    runtimeRoot,
    runtimeSha: sha,
    sourceSha: core.getInput("source-sha", { required: true }),
    rendererImage: core.getInput("renderer-image", { required: true }),
    mediaProfile: core.getInput("media-profile") || "archive-v1",
  };
}
