import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { createGitHubCliApi } from "../../providers/github-cli-api.js";
import { pullRequestProvider } from "../../providers/github/pull-requests.js";
import { normalizeLineBootstrapRequest } from "./request.js";
import { lineBootstrapSummary } from "./plan.js";
import { bootstrapReleaseLine } from "./transaction.js";
export async function lineBootstrapAction(core, env) {
  const request = normalizeLineBootstrapRequest(
      core.getInput("request-json", { required: true }),
    ),
    sourceRoot = path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot = installationRoot(import.meta.url);
  if (
    fs.realpathSync(runtimeRoot) !==
    fs.realpathSync(path.join(sourceRoot, ".buildchain/workflow-shell"))
  )
    throw new Error(
      "Release line action requires its defining workflow implementation",
    );
  verifyCheckoutIdentity({
    directory: runtimeRoot,
    sha: core.getInput("workflow-sha", { required: true }),
    label: "Release line workflow",
  });
  const token = core.getInput("token", { required: request.apply }),
    repository = env.GITHUB_REPOSITORY;
  const providers = request.apply
    ? {
        api: createGitHubCliApi(undefined, { ...env, GH_TOKEN: token }),
        pullRequests: pullRequestProvider({
          repository,
          token,
          apiUrl: env.GITHUB_API_URL,
        }),
      }
    : undefined;
  const result = await bootstrapReleaseLine(
    { ...request, sourceRoot, repository },
    { providers },
  );
  await core.summary
    .addRaw(lineBootstrapSummary(result.plan, result.applied))
    .write();
  core.info(JSON.stringify(result, null, 2));
  return result;
}
