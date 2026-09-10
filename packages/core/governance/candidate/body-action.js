import path from "node:path";
import { runCandidateBodyPrefixRenderer } from "./body-renderer.js";
export function renderCandidateBodyAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const value = runCandidateBodyPrefixRenderer({
    consumerRoot: path.join(env.GITHUB_WORKSPACE, ".buildchain/consumer"),
    renderer: request["pull-request-body-prefix-renderer"],
    selectedSha: core.getInput("source-sha", { required: true }),
    sourceBranch: request["source-branch"],
    targetBranch: request["target-branch"],
    outputPath: path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain/patrol/pull-request-body-prefix.txt",
    ),
    environment: env,
  });
  core.setOutput("pull-request-body-prefix", value);
}
