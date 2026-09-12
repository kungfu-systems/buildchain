import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelineBuildEvidence } from "./build-evidence.js";

async function record(session, phase, state, receipt, host, reason = "") {
  const observed = await session.journal.read();
  const root = recordDigest(receipt);
  const reference = await host
    .materialStore(session)
    .retain(`${phase}/${root.slice(7)}`, receipt, "provider-readback");
  return session.progress.progress({
    attempt: observed.attempt,
    phase,
    state,
    eventKey: `${phase}:${state}:${root}`,
    reason,
    materials: [reference],
  });
}

async function channelMerge(session, admission, host) {
  const observed = await session.journal.read();
  const current = { ...observed.history.at(-1), intent: session.intent };
  if (current.phases.merge?.payload.state !== "success") {
    const integration = await host.integration.observe(current);
    await record(session, "merge", "success", integration, host);
  }
  if (host.terminalOnly) {
    await host.wake(observed.attempt);
    return {
      operation: "wait",
      reason: "publication-requires-a-normal-dispatch",
      attempt: observed.attempt,
    };
  }
  // Product publication is a separate typed domain stage. This operation keeps
  // the business attempt open until its published byte/readback receipts exist.
  return {
    operation: "publish",
    attempt: observed.attempt,
    source: admission.live.source,
  };
}

export async function controlPipelineChannel(session, admission, inputs, host) {
  const observed = await session.journal.read();
  const current = { ...observed.history.at(-1), intent: session.intent };
  const { live } = admission;
  if (live.merged) return channelMerge(session, admission, host);
  if (
    live.state !== "open" ||
    !live.source ||
    live.routeEnabled === false ||
    live.targetBranch !== session.intent.source.targetBranch ||
    live.baseCommit !== current.generation.baseCommit
  ) {
    await record(
      session,
      observed.missing[0],
      "superseded",
      live,
      host,
      "channel-source-no-longer-admitted",
    );
    return {
      operation: "successor",
      reason: "channel-source-no-longer-admitted",
    };
  }
  if (host.terminalOnly)
    return { operation: "wait", reason: "terminal-event-cannot-execute" };
  const build = await pipelineBuildEvidence(session, host);
  if (!build) return { operation: "build", admission };
  if (build.run.status !== "completed" || build.run.conclusion !== "success")
    return { operation: "wait", reason: "source-workflow-not-qualified" };
  const policy = await host.policy.observe(
    current,
    admission.protectedPlan.review,
  );
  if (!policy.review || !policy.checksPassing || !live.ready || live.draft)
    return { operation: "wait", reason: "protected-channel-gates-pending" };
  if (!current.phases.review)
    await record(session, "review", "success", policy, host);
  const queue = await host.queue.getMergeQueueState(
    session.intent.source.targetBranch,
  );
  if (!queue.enabled)
    throw new Error("Protected channel merge queue is disabled");
  const entry = queue.entries.find(
    (item) => item.pullRequestNumber === live.pullRequest,
  );
  if (entry) {
    if (entry.pullRequestHeadSha !== live.source.commit)
      throw new Error("Protected queue source drift");
    return { operation: "wait", reason: "channel-in-protected-merge-queue" };
  }
  await record(
    session,
    "merge",
    "waiting",
    { schema: "buildchain.pipeline-channel-enqueue/v1", policy, queue },
    host,
  );
  const again = await host.source.observeIntent(
    session.intent,
    current.generation,
    inputs,
  );
  if (recordDigest(again.live) !== recordDigest(live))
    throw new Error("Channel changed before queue admission");
  await host.queue.enqueuePullRequest({
    pullRequestId: policy.pr.id,
    expectedHeadOid: live.source.commit,
  });
  const readback = await host.queue.getMergeQueueState(
    session.intent.source.targetBranch,
  );
  if (
    !readback.entries.some(
      (item) =>
        item.pullRequestNumber === live.pullRequest &&
        item.pullRequestHeadSha === live.source.commit,
    )
  )
    throw new Error("Channel queue admission requires exact provider readback");
  await record(session, "merge", "waiting", readback, host);
  return { operation: "wait", reason: "channel-enqueued" };
}
