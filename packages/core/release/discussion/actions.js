import { discussionStatus } from "./reader.js";
import * as github from "@actions/github";
import { openReleaseSession, selectedRecordRuntime } from "./session.js";
import { releaseDiscussionStore } from "./store.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";
import { createProgress } from "./envelope.js";

function actionStore(core) {
  return releaseDiscussionStore(
    discussionTransport(
      github.getOctokit(core.getInput("token", { required: true })).graphql,
    ),
  );
}

export async function openDiscussionAction(core, env) {
  const result = await openReleaseSession({
    graphql: github.getOctokit(core.getInput("token", { required: true }))
      .graphql,
    repository: env.GITHUB_REPOSITORY,
    key: core.getInput("intent-key", { required: true }),
    source: JSON.parse(core.getInput("source-json", { required: true })),
    expectedNodes: JSON.parse(
      core.getInput("expected-nodes-json", { required: true }),
    ),
    runtime: selectedRecordRuntime(env),
    attempt: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
    discussionId: core.getInput("discussion-id"),
    predecessor: core.getInput("predecessor"),
    dryRun: core.getBooleanInput("dry-run"),
  });
  core.setOutput("session-json", JSON.stringify(result.session));
  core.setOutput("discussion-id", result.session.discussion?.id || "");
  core.setOutput("discussion-url", result.session.discussion?.url || "");
}

export async function recordDiscussionAction(core, env) {
  const session = JSON.parse(core.getInput("session-json", { required: true }));
  if (session.dryRun) return;
  const record = createProgress({
    intent: session.intent,
    runtime: selectedRecordRuntime(env),
    attempt: session.attempt,
    writer: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}:${env.GITHUB_JOB}`,
    predecessor: session.predecessor,
    node: core.getInput("node", { required: true }),
    status: core.getInput("status", { required: true }),
    sequence: Number(core.getInput("sequence")),
    payload: JSON.parse(core.getInput("payload-json") || "{}"),
  });
  const result = await actionStore(core).append(session, record);
  core.setOutput("record-id", result.id);
}

export async function inspectDiscussionAction(core) {
  const session = JSON.parse(core.getInput("session-json", { required: true }));
  if (session.dryRun) {
    core.setOutput("status", "dry-run");
    return;
  }
  const result = await actionStore(core).read(session);
  core.setOutput("status", result.status);
  core.setOutput("handoff-json", JSON.stringify(result.handoff || {}));
  core.setOutput("state-json", JSON.stringify(discussionStatus(result)));
}
