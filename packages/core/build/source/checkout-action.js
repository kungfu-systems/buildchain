import path from "node:path";
import { verifySourceRuntimeCheckouts } from "../../runtime/checkout-identity.js";
export function verifySourceRuntimeAction(core, env) {
  verifySourceRuntimeCheckouts({
    sourceDirectory: path.resolve(
      env.GITHUB_WORKSPACE,
      core.getInput("source-directory"),
    ),
    sourceSha: core.getInput("source-sha", { required: true }),
    runtimeDirectory: path.resolve(
      env.GITHUB_WORKSPACE,
      core.getInput("runtime-directory"),
    ),
    runtimeSha: core.getInput("runtime-sha", { required: true }),
  });
}
