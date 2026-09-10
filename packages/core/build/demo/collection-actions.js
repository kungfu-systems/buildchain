import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { demoActionContext } from "./action-context.js";
import { captureDemoCollection, qualifyCapturedDemos } from "./collection.js";
import { demoCollectionIdentity } from "./collection-context.js";
import { publishDemoCollection } from "./publication.js";
import { pullRequestProvider } from "../../providers/github/pull-requests.js";
function collectionRequest(core, env) {
  const request = {
    ...demoActionContext(core, env),
    scenarioPath: core.getInput("scenario-path", { required: true }),
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
  };
  if (
    command(
      "git",
      ["-C", path.join(request.workspace, "source"), "rev-parse", "HEAD"],
      { stdio: "pipe" },
    ).trim() !== request.sourceSha
  )
    throw new Error("Demo collection source differs from admitted source");
  return request;
}
export function captureDemoCollectionAction(core, env) {
  const request = collectionRequest(core, env);
  captureDemoCollection(request);
  core.setOutput("name", demoCollectionIdentity(request, "captures"));
}
export async function qualifyCapturedDemosAction(core, env) {
  const request = {
    ...collectionRequest(core, env),
    renderMedia: core.getBooleanInput("render-media"),
    renderFailureAdvisory: core.getBooleanInput("render-failure-advisory"),
  };
  const result = qualifyCapturedDemos(request, {
    onAdvisoryFailure: (error) =>
      core.warning(
        `Full-media rendering failed in advisory mode: ${error.message}. The required Gate remains successful; publication is suppressed.`,
      ),
  });
  core.setOutput("name", demoCollectionIdentity(request, "evidence"));
  core.setOutput("render-result", result.renderOutcome);
  if (result.renderOutcome === "failure" && env.GITHUB_STEP_SUMMARY)
    await core.summary
      .addHeading("Auditable demo media", 3)
      .addRaw(
        "Full-media rendering failed in advisory mode. The required Gate remains successful and no materialization PR will be opened.",
      )
      .write();
}
export async function publishDemoCollectionAction(core, env) {
  const request = {
    ...collectionRequest(core, env),
    baseRef: core.getInput("base-ref", { required: true }),
  };
  const provider = pullRequestProvider({
    repository: env.GITHUB_REPOSITORY,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
  });
  core.setOutput("url", await publishDemoCollection(request, { provider }));
}
