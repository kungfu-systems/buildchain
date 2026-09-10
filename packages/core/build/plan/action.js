import path from "node:path";
import { execFileSync } from "node:child_process";
import { getOctokit } from "@actions/github";
import { installationRoot } from "../../runtime/installation-root.js";
import { reportBuildchainIssue } from "../../governance/issue-reporting.js";
import { readJson } from "./values.js";
import { resolveBuildPlan } from "./resolve.js";

export async function resolveBuildPlanAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  const runtimeRoot = installationRoot(import.meta.url);
  const workflowSha = core.getInput("workflow-sha", { required: true });
  if (
    execFileSync("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim() !== workflowSha
  )
    throw new Error("Executing runtime differs from called workflow");
  const token = core.getInput("token", { required: true });
  const github = getOctokit(token);
  const coordinates = (repository) => {
    const [owner, repo] = repository.split("/");
    return { owner, repo };
  };
  const plan = await resolveBuildPlan(
    {
      workspace,
      sourceRoot: path.join(workspace, "source"),
      runtimeRoot,
      configPath: core.getInput("config-path"),
      workflow: {
        ref: core.getInput("workflow-ref", { required: true }),
        sha: workflowSha,
        callerRef: env.GITHUB_WORKFLOW_REF,
        name: env.GITHUB_WORKFLOW,
        runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      },
      source: {
        sha: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        refName: env.GITHUB_REF_NAME,
        baseRef: env.GITHUB_BASE_REF,
      },
      event: {
        name: env.GITHUB_EVENT_NAME,
        payload: env.GITHUB_EVENT_PATH ? readJson(env.GITHUB_EVENT_PATH) : {},
      },
      run: {
        repository: env.GITHUB_REPOSITORY,
        id: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
      },
    },
    {
      reportIssue: (request) => reportBuildchainIssue({ ...request, token }),
      summarize: (text) => core.summary.addRaw(text + "\n\n").write(),
      warn: core.warning,
      runnerInventory: {
        token: core.getInput("control-token"),
        apiUrl: env.GITHUB_API_URL,
      },
      channel: {
        resolveRefSha: async ({ repository, sourceRef }) =>
          (
            await github.rest.git.getRef({
              ...coordinates(repository),
              ref: `heads/${sourceRef}`,
            })
          ).data.object.sha,
        listPullRequests: ({ repository, sha }) =>
          github.paginate(
            github.rest.repos.listPullRequestsAssociatedWithCommit,
            { ...coordinates(repository), commit_sha: sha, per_page: 100 },
          ),
      },
    },
  );
  core.setOutput("plan", plan);
}
