import path from "node:path";
import { deliveryActionContext } from "../native/action-context.js";
import { admissionPolicyRequest } from "../admission/request.js";
import { runAdmissionTransaction } from "../admission/transaction.js";
import { enforceLanding } from "./completion.js";
import { guardPipelineAdmission } from "../../workflow/pipeline/guard.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { publishPipelineBuildStatus } from "../../workflow/pipeline/guard-build.js";
import { publishIntegratedPipelineStatus } from "../../workflow/pipeline/integration-status.js";
import { githubPipelineIntegration } from "../../providers/github/pipeline-integration.js";
import { githubPipelineSource } from "../../providers/github/pipeline-source.js";
import { githubPipelineRuns } from "../../providers/github/pipeline-runs.js";
import { GitHubClient } from "../admission/github-client.js";
export async function admitLandingAction(core, env) {
  const context = deliveryActionContext(core, env);
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const admitted = await guardPipelineAdmission(request, {
    repository: env.GITHUB_REPOSITORY,
    token: core.getInput("token", { required: true }),
    publishBuildStatus: (build) =>
      publishPipelineBuildStatus(
        request,
        build,
        githubJsonClient({
          token: core.getInput("status-token", { required: true }),
          userAgent: "buildchain-qualified-status",
        }),
        env.GITHUB_REPOSITORY,
      ),
  });
  const result = await runAdmissionTransaction(
    {
      ...admissionPolicyRequest(request, {
        repository: env.GITHUB_REPOSITORY,
        branch: core.getInput("branch", { required: true }),
        workspace: context.workspace,
      }),
      warrantResultPath: path.join(
        context.workspace,
        ".buildchain/dev-delivery/warrant.json",
      ),
      projectCutProofPath: core.getInput("project-cut-proof-root")
        ? path.join(
            context.workspace,
            ".buildchain/dev-delivery/project-cut-proof.json",
          )
        : "",
      outputPath: path.join(
        context.workspace,
        ".buildchain/dev-pr-auto-merge/result.json",
      ),
    },
    {
      token: core.getInput("token", { required: true }),
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      useGhCli: false,
    },
  );
  for (const [name, value] of Object.entries(result.outputs))
    core.setOutput(name, value);
  if (env.GITHUB_STEP_SUMMARY)
    await core.summary.addRaw(result.summary).write();
  if (!result.ok)
    throw new Error("Targeted PR was not admitted at its expected head");
  if (admitted) {
    const repository = env.GITHUB_REPOSITORY;
    const token = core.getInput("token", { required: true });
    const read = githubJsonClient({
      token,
      userAgent: "buildchain-integration-status",
    });
    const [owner, repo] = repository.split("/");
    const queue = new GitHubClient({ repository: { owner, repo }, token });
    await publishIntegratedPipelineStatus(
      {
        ...admitted.history.at(-1),
        intent: admitted.intent,
      },
      {
        repository,
        request: read,
        queue: (branch) => queue.getMergeQueueState(branch),
        integration: githubPipelineIntegration(
          read,
          repository,
          githubPipelineSource(read, repository),
          githubPipelineRuns(read, repository),
        ),
        status: githubJsonClient({
          token: core.getInput("status-token", { required: true }),
          userAgent: "buildchain-qualified-integration-status",
        }),
      },
    );
  }
}
export function completeDeliveryAction(core) {
  enforceLanding({
    alreadyQualified: core.getInput("already-qualified"),
    boundaryOutcome: core.getInput("boundary-outcome"),
    nativeQualificationOutcome: core.getInput("native-qualification-outcome"),
    deferLanding: core.getInput("defer-landing"),
    warrantMode: core.getInput("warrant-mode"),
    nativeJobOutcome: core.getInput("native-job-outcome"),
    failureSettlementOutcome: core.getInput("failure-settlement-outcome"),
    runNative: core.getInput("run-native"),
    sealJobOutcome: core.getInput("seal-job-outcome"),
    heartbeatJobOutcome: core.getInput("heartbeat-job-outcome"),
    mergeStepOutcome: core.getInput("merge-step-outcome"),
    targetedOk: core.getInput("targeted-ok"),
    targeted: core.getInput("targeted"),
  });
}
