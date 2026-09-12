import { getOctokit } from "@actions/github";
import { observeBinaryDistribution } from "../../release/discussion/binary.js";
import { selectedRecordRuntime } from "../../release/discussion/session.js";
import path from "node:path";
import { verifyCheckoutIdentity } from "../../runtime/checkout-identity.js";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import { publishBinaryAssets } from "./transaction.js";
export async function publishBinaryAssetsAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE),
    sourceSha = core.getInput("source-sha", { required: true });
  verifyCheckoutIdentity({
    directory: workspace,
    sha: sourceSha,
    label: "Publication source",
  });
  const client = releaseAssetClient(env.GITHUB_REPOSITORY, {
    token: core.getInput("token", { required: true }),
  });
  const result = await observeBinaryDistribution(
    {
      client,
      octokit: getOctokit(core.getInput("token", { required: true })),
      repository: env.GITHUB_REPOSITORY,
      tag: core.getInput("tag", { required: true }),
      runtime: selectedRecordRuntime(env),
      writer: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}`,
    },
    () =>
      publishBinaryAssets(
        {
          workspace,
          repository: env.GITHUB_REPOSITORY,
          sourceSha,
          tag: core.getInput("tag", { required: true }),
          capability: JSON.parse(
            core.getInput("capability-json", { required: true }),
          ),
        },
        client,
      ),
  );
  core.info(
    `Verified ${result.assets.length} immutable binary assets for ${result.tag}`,
  );
}
