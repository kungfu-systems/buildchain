import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { createGitHubQualificationClient } from "../../providers/github/qualification.js";
import { qualifyPublicBuild } from "./public-build.js";
function inputs(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    fs.realpathSync(installationRoot(import.meta.url)) !==
    fs.realpathSync(workspace)
  )
    throw new Error(
      "Stable candidate qualification requires the checked-out source implementation",
    );
  return {
    workspace,
    repositoryName: env.GITHUB_REPOSITORY,
    runId: core.getInput("run-id", { required: true }),
    client: createGitHubQualificationClient({
      token: core.getInput("token", { required: true }),
    }),
  };
}
export async function resolvePublicQualificationAction(core, env) {
  const { repositoryName, runId, client } = inputs(core, env);
  const run = await client.readPublicBuildRun(repositoryName, runId);
  core.setOutput("artifact-name", `buildchain-summary-${run.head_sha}`);
}
export async function qualifyPublicCandidateAction(core, env) {
  const { workspace, repositoryName, runId, client } = inputs(core, env);
  const sourceRun = await client.readPublicBuildRun(repositoryName, runId);
  const buildSummary = JSON.parse(
    fs.readFileSync(
      path.join(
        workspace,
        ".buildchain/qualification/source/build-summary.json",
      ),
      "utf8",
    ),
  );
  const result = await qualifyPublicBuild(
    { repositoryName, sourceRun, buildSummary },
    client,
  );
  const output = path.join(workspace, ".buildchain/qualification/result.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  core.info(
    `Qualified exact alpha ${result.candidate.sha} from public build ${result.runId}`,
  );
}
