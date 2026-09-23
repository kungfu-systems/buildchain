import { pipelineEvent } from "./events.js";
import { selectPipelineSession } from "./selection.js";
import { beginPipelineBuild } from "./build-control.js";
import { controlPipelineDelivery } from "./delivery-control.js";
import {
  githubPipelineEvents,
  githubPipelineQueueExit,
} from "../../providers/github/pipeline-events.js";
import { pipelinePlatforms } from "./platforms.js";
import { recordDigest } from "../../release/discussion/envelope.js";

async function groupBuild(event, inputs, host) {
  const queue = await host.queue.getMergeQueueState(event.branch);
  if (
    !queue.enabled ||
    !queue.entries.some(
      (entry) =>
        entry.headSha === event.commit && entry.baseSha === event.baseCommit,
    )
  )
    throw new Error(
      "Merge-group execution is not in the exact protected provider queue",
    );
  const admitted = await host.source.source(
    event.commit,
    inputs["config-path"],
  );
  const context = {
    schema: "buildchain.pipeline-group-build-context/v1",
    source: admitted.identity,
    branch: event.branch,
    baseCommit: event.baseCommit,
    runId: host.runId,
    runAttempt: host.runAttempt,
    platforms: pipelinePlatforms(admitted.plan),
  };
  return { operation: "build", context };
}

async function wakePipeline(host, attempt, reason) {
  await host.wake(attempt);
  return { operation: "wait", reason, attempt };
}

export async function controlPipeline(name, payload, inputs, host) {
  const event = pipelineEvent(name, payload, host.repository);
  host.terminalOnly = event.terminalOnly;
  host.eventAction = payload.action || "";
  if (event.kind === "ignore")
    return { operation: "wait", reason: event.reason };
  if (event.kind === "branch") {
    const events = githubPipelineEvents(
      host.request,
      host.provider,
      host.repository,
    );
    const attempts = await events.branch(event.branch, event.commit);
    for (const attempt of attempts) await host.wake(attempt);
    return {
      operation: "wait",
      reason: "existing-channel-intents-woken",
      count: attempts.length,
    };
  }
  if (event.kind === "merge-group") return groupBuild(event, inputs, host);
  const selected = await selectPipelineSession(event, payload, inputs, host);
  if (!selected)
    return { operation: "wait", reason: "no-admitted-pipeline-intent" };
  const { session, admission } = selected;
  const current = session.observed.history.at(-1);
  if (
    current.identity.requestKey.startsWith("recover:") &&
    recordDigest(current.events[0].runtime) !== recordDigest(host.runtime)
  )
    return wakePipeline(
      host,
      current.identity.id,
      "admitted-recovery-runtime-continuation-required",
    );
  if (
    ["failure", "cancelled", "superseded", "complete"].includes(
      session.observed.status,
    )
  ) {
    await host.notifyTerminal?.(session);
    await host.project(session);
    return {
      operation: "wait",
      reason: `attempt-${session.observed.status}`,
      attempt: session.observed.attempt,
    };
  }
  if (
    admission.live.source &&
    host.selection.source.sha !== admission.live.source.commit
  )
    return wakePipeline(
      host,
      session.observed.attempt,
      "source-generation-runtime-selection-required",
    );
  if (session.intent.expectedNodes.includes("warrant"))
    host.queueExit ||= githubPipelineQueueExit(
      host.github.graphql,
      host.repository,
    );
  const operation = session.intent.expectedNodes.includes("warrant")
    ? await controlPipelineDelivery(session, inputs, host)
    : await host.channel(session, admission, inputs);
  if (operation.operation === "build") {
    const context = await beginPipelineBuild(
      session,
      operation.admission || admission,
      host,
    );
    await host.project(session);
    if (!context)
      return { operation: "wait", reason: "existing-build-execution-retained" };
    return { operation: "build", context };
  }
  await host.project(session);
  // PR run.head_sha and signing certificates can name different commits.
  const dispatchPublication =
    operation.operation === "publish" && event.kind !== "attempt";
  if (operation.operation === "successor" || dispatchPublication)
    return wakePipeline(
      host,
      session.observed.attempt,
      operation.reason || "publication-requires-a-normal-dispatch",
    );
  if (operation.operation === "settle") {
    const settled = await host.settle(
      session,
      operation.fresh,
      operation.delivery,
    );
    await host.project(session);
    return settled;
  }
  return operation;
}
