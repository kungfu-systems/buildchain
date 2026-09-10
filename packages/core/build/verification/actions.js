import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { command } from "../../runtime/action-process.mjs";
import { qualifyRepositorySource, verificationProvider } from "./source.js";

export async function qualifyRepositorySourceAction(core, env) {
  const workspace = env.GITHUB_WORKSPACE,
    runtimeRoot = path.join(workspace, ".buildchain/runtime");
  const sha = (cwd) =>
    command("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).trim();
  if (
    sha(workspace) !== env.GITHUB_SHA ||
    sha(runtimeRoot) !== env.GITHUB_SHA ||
    path.resolve(installationRoot(import.meta.url)) !== path.resolve(workspace)
  )
    throw new Error(
      "Repository verification requires exact source-owned code and matching runtime checkout",
    );
  return qualifyRepositorySource(
    {
      workspace,
      runtimeRoot,
      env,
      summaryPath: env.GITHUB_STEP_SUMMARY,
      provider: verificationProvider({
        workspace,
        env,
        token: core.getInput("token", { required: true }),
      }),
    },
    {
      observe: (outputs) => {
        for (const [key, value] of Object.entries(outputs))
          core.setOutput(key, value);
      },
    },
  );
}
export function qualifyBuildBackboneAction(_core, env) {
  const root = installationRoot(import.meta.url);
  if (path.resolve(root) !== path.resolve(env.GITHUB_WORKSPACE))
    throw new Error(
      "Build backbone tests must execute from the admitted source checkout",
    );
  command(
    "node",
    [
      "--test",
      "tests/build-orchestration.test.mjs",
      "tests/build-artifact-pipeline.test.mjs",
    ],
    { cwd: root, env },
  );
}
