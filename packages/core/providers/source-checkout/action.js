import path from "node:path";
import { lockedSourceCheckout } from "./transaction.js";
import { resetSourceWorktree } from "./workspace.js";
export function checkoutExactSourceAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const checkoutPath = core.getInput("directory", { required: true });
  if (core.getInput("reset-working-tree") === "true")
    resetSourceWorktree({ workspace, checkoutPath });
  const evidence = lockedSourceCheckout({
    workspace,
    checkoutPath,
    repository: core.getInput("repository", { required: true }),
    sourceSha: core.getInput("sha", { required: true }),
    sourceTreeSha: core.getInput("tree-sha"),
    fetchRef: core.getInput("ref"),
    mode: core.getInput("cache-mode"),
    mirrorUrlTemplate: core.getInput("mirror-url-template"),
    referenceRepositoryTemplate: core.getInput("reference-repository-template"),
    fallback: core.getInput("fallback"),
    timeoutSeconds: Number(core.getInput("cache-timeout-seconds")),
    githubTimeoutSeconds: Number(core.getInput("github-timeout-seconds")),
    fetchAttempts: Number(core.getInput("fetch-attempts")),
    diagnosticsPath: core.getInput("diagnostics-path"),
    githubToken: core.getInput("token", { required: true }),
    githubServerUrl: env.GITHUB_SERVER_URL,
    historyMode: core.getInput("history"),
    environment: env,
  });
  core.setOutput("sha", evidence.verification.head);
  core.setOutput("tree", evidence.verification.tree);
}
