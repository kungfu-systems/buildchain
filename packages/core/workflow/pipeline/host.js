import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getOctokit } from "@actions/github";
import { installationRoot } from "../../runtime/installation-root.js";
import { preparedRuntimeSelection } from "../../runtime/entry/selection.js";
import { githubJsonClient } from "../../providers/github/json-client.js";
import { githubAttemptJournal } from "../../providers/github/attempt-journal.js";
import { githubAttemptIndex } from "../../providers/github/attempt-index.js";
import { githubPipelineSource } from "../../providers/github/pipeline-source.js";
import { githubPipelineRuns } from "../../providers/github/pipeline-runs.js";
import { githubPipelineWorker } from "../../providers/github/pipeline-worker.js";
import { githubPipelinePolicy } from "../../providers/github/pipeline-policy.js";
import { discussionMaterials } from "../../providers/github/discussions/materials.js";
import { pipelineMaterials } from "./materials.js";
import { GitHubClient } from "../../dev-delivery/admission/github-client.js";
import { githubPipelineIntegration } from "../../providers/github/pipeline-integration.js";
import { recordPipelineGroup } from "./group-control.js";
import { controlPipelineChannel } from "./channel-control.js";
import { settlePipeline } from "./settlement.js";
import { pipelineProjection } from "./projection.js";
import { resumePipelineNotifications } from "./notifications.js";

export async function pipelineHost(core, env, jobName) {
  const token = core.getInput("token", { required: true });
  const repository = env.GITHUB_REPOSITORY;
  const selection = preparedRuntimeSelection(
    JSON.parse(env.BUILDCHAIN_RUNTIME_SELECTION),
  );
  const runtimeRoot = installationRoot(import.meta.url);
  const reader = fs.readFileSync(
    path.join(runtimeRoot, "dist/readers/business-attempt.cjs"),
  );
  const runtime = {
    repository: selection.repository,
    sha: selection.sha,
    readerDigest: `sha256:${createHash("sha256").update(reader).digest("hex")}`,
  };
  const request = githubJsonClient({ token, userAgent: "buildchain-pipeline" });
  const github = getOctokit(token);
  const provider = githubAttemptJournal(request);
  const index = githubAttemptIndex(request, provider, repository);
  const runs = githubPipelineRuns(request, repository);
  const runId = Number(env.GITHUB_RUN_ID),
    runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  const writer = await runs.writer(runId, runAttempt, jobName);
  const source = githubPipelineSource(request, repository);
  const [owner, repo] = repository.split("/");
  const host = {
    repository,
    token,
    github,
    selection,
    runtime,
    runtimeRoot,
    request,
    provider,
    index,
    runs,
    runId,
    runAttempt,
    writer,
    source,
    workers: githubPipelineWorker(request),
    policy: githubPipelinePolicy(request, repository),
    queue: new GitHubClient({ repository: { owner, repo }, token }),
    integration: githubPipelineIntegration(request, repository, source, runs),
    groupRecord: (context) => recordPipelineGroup(context, host),
    channel: (session, admission, inputs) =>
      controlPipelineChannel(session, admission, inputs, host),
    settle: (session, fresh, delivery) =>
      settlePipeline(session, fresh, delivery, host),
    project: pipelineProjection(github.graphql),
    notifyTerminal: (session) => resumePipelineNotifications(session, host),
    materialStore: (session) =>
      pipelineMaterials(
        discussionMaterials({
          octokit: github,
          repository,
          intentId: session.intent.id,
          authorityDescription:
            "The canonical Buildchain intent Git journal owns transaction state.",
        }),
        { repository, attempt: session.observed.history.at(-1).identity },
      ),
    productArchive: (session) =>
      discussionMaterials({
        octokit: github,
        repository,
        intentId: session.intent.id,
        authorityDescription:
          "The canonical Buildchain intent Git journal owns transaction state.",
      }),
    wake: async (attempt) => {
      await index.resolve(attempt);
      await request(`/repos/${repository}/dispatches`, {
        method: "POST",
        body: {
          event_type: "buildchain-attempt-wake",
          client_payload: { attempt },
        },
      });
    },
  };
  return host;
}
