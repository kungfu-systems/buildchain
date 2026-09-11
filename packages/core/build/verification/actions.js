import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { qualifyRepositorySource, verificationProvider } from "./source.js";

export async function qualifyRepositorySourceAction(core, env) {
  const workspace = env.GITHUB_WORKSPACE,
    runtimeRoot = path.join(workspace, ".buildchain/runtime");
  const sha = (cwd) =>
    command("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).trim();
  if (sha(workspace) !== env.GITHUB_SHA)
    throw new Error(
      "Repository verification requires the invoked source checkout",
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
  const root = path.resolve(env.GITHUB_WORKSPACE);
  command(
    "node",
    [
      "--test",
      "tests/build-orchestration.test.mjs",
      "tests/build-artifact-pipeline.test.mjs",
      "tests/dev-delivery-minimal-request.test.mjs",
    ],
    { cwd: root, env },
  );
}
