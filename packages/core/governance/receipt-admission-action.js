import { installationRoot } from "../runtime/installation-root.js";
import { admitGithubGovernanceReceipt } from "./receipt-admission.js";

export function admitGithubGovernanceAction(core, env) {
  return admitGithubGovernanceReceipt({
    receipt: JSON.parse(core.getInput("receipt-json", { required: true })),
    repository: env.GITHUB_REPOSITORY,
    targetRef: env.GITHUB_REF_NAME,
    runtimeRoot: installationRoot(import.meta.url),
    runtimeSha: core.getInput("runtime-sha", { required: true }),
  });
}
