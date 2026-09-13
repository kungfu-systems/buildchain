import { recordDigest } from "../../release/discussion/envelope.js";
import { preparePipelineDelivery } from "./delivery-request.js";
import { pipelineBuildEvidence } from "./build-evidence.js";
import {
  observePipelineWorker,
  pipelineDeliveryStore,
} from "./delivery-observation.js";
import { reconcilePipeline, pipelineCandidate } from "./reconcile.js";
import {
  cancelPipelineCandidate,
  recoverPipelineCancellation,
} from "./cancellation.js";
import { readBusinessAttempt } from "../attempt/reader.js";

export async function observePipelineDelivery(session, inputs, host, delivery) {
  const observed = await session.journal.read();
  const current = { ...observed.history.at(-1), intent: session.intent };
  const admission = await host.source.observeIntent(
    session.intent,
    current.generation,
    inputs,
  );
  admission.live.terminalOnly = host.terminalOnly === true;
  admission.live.dequeued = host.eventAction === "dequeued";
  const queue = await delivery.read();
  const worker = await observePipelineWorker(session, current, queue, host);
  const input = { current, live: admission.live, queue, worker, evidence: {} };
  return {
    ...input,
    admission,
    observed,
    attempt: observed.attempt,
    phase: observed.missing[0],
    decision: reconcilePipeline(input),
  };
}

async function cleanup(fresh, session, inputs, host, delivery) {
  const ports = {
    observe: () => observePipelineDelivery(session, inputs, host, delivery),
    progress: session.progress,
    service: delivery.service,
    materials: host.materialStore(session),
    wake: async (successor) => {
      const retained = await host.provider.lookup(
        host.repository,
        successor.pullRequestNumber,
        session.intent.source.targetBranch,
      );
      if (retained)
        await host.wake(readBusinessAttempt(retained.snapshot).attempt);
    },
  };
  if (fresh.decision.operation === "record-cancellation")
    return recoverPipelineCancellation(fresh, ports);
  if (
    ["stop-worker", "cancel-queued", "settle-cancelled"].includes(
      fresh.decision.operation,
    )
  )
    return cancelPipelineCandidate(fresh, ports);
  return null;
}

async function retainDeliveryRequest(fresh, session, build, host) {
  const scheduling = await session.journal.read();
  const schedulingCurrent = {
    ...scheduling.history.at(-1),
    intent: session.intent,
  };
  const active = await observePipelineWorker(
    session,
    schedulingCurrent,
    fresh.queue,
    host,
  );
  if (active?.status === "in_progress")
    return { operation: "wait", reason: "native-worker-running" };
  const request = await (host.prepareDelivery || preparePipelineDelivery)({
    current: fresh.current,
    run: build.run,
    build: build.readback,
    runtimeSha: host.runtime.sha,
    token: host.token,
    plan: fresh.admission.plan,
  });
  const execution = {
    schema: "buildchain.pipeline-delivery-execution/v1",
    attempt: fresh.attempt,
    generation: fresh.current.generation.id,
    runId: host.runId,
    runAttempt: host.runAttempt,
    request,
  };
  const reference = await host
    .materialStore(session)
    .retain(`delivery/execution-${host.runId}-${host.runAttempt}`, execution);
  await session.progress.progress({
    attempt: fresh.attempt,
    phase: "warrant",
    state: "running",
    eventKey: `delivery:${host.runId}:${host.runAttempt}`,
    materials: [reference],
    expectedHead: scheduling.head,
  });
  return { operation: "deliver", request, attempt: fresh.attempt };
}

export async function controlPipelineDelivery(session, inputs, host) {
  const delivery = host.delivery
    ? host.delivery(session)
    : pipelineDeliveryStore(session, host);
  const fresh = await observePipelineDelivery(session, inputs, host, delivery);
  const candidate = pipelineCandidate(fresh.queue, fresh.current);
  if (["cancelled", "dequeued"].includes(candidate?.status))
    fresh.decision = {
      operation: "record-cancellation",
      candidateId: candidate.candidateId,
    };
  if (candidate?.status === "terminal-failure") {
    const material = await host
      .materialStore(session)
      .retain(
        `failure/${fresh.queue.stateRoot.slice(7)}`,
        fresh.queue,
        "provider-readback",
      );
    await session.progress.progress({
      attempt: fresh.attempt,
      phase: fresh.phase,
      state: "failure",
      eventKey: `failure:${fresh.queue.stateRoot}`,
      reason: "native-execution-failed",
      materials: [material],
    });
    return { operation: "wait", reason: "native-execution-failed" };
  }
  const result = await cleanup(fresh, session, inputs, host, delivery);
  if (result) {
    if (result.status === "cancelled") await host.wake(fresh.attempt);
    return { operation: "wait", reason: result.reason || result.status };
  }
  if (fresh.decision.operation === "supersede") {
    if (
      !["cancelled", "failure", "superseded", "complete"].includes(
        fresh.observed.status,
      )
    )
      await session.progress.progress({
        attempt: fresh.attempt,
        phase: fresh.phase,
        state: "superseded",
        eventKey: `supersede:${recordDigest(fresh.live)}`,
        reason: fresh.decision.reason,
      });
    return { operation: "successor", reason: fresh.decision.reason };
  }
  if (fresh.live.merged) return { operation: "settle", fresh, delivery };
  if (fresh.live.state !== "open" || fresh.live.terminalOnly)
    return { operation: "wait", reason: "no-execution-admission" };
  const build = await pipelineBuildEvidence(session, host);
  if (!build) return { operation: "build", admission: fresh.admission };
  if (build.run.status !== "completed")
    return { operation: "wait", reason: "source-workflow-still-running" };
  const policy = await host.policy.observe(
    fresh.current,
    fresh.admission.protectedPlan.review,
  );
  if (
    !policy.review ||
    !policy.checksPassing ||
    !fresh.live.ready ||
    fresh.live.draft
  )
    return { operation: "wait", reason: "protected-source-gates-pending" };
  if (!fresh.current.phases.review) {
    const material = await host
      .materialStore(session)
      .retain(`review/${policy.root.slice(7)}`, policy, "provider-readback");
    await session.progress.progress({
      attempt: fresh.attempt,
      phase: "review",
      state: "success",
      eventKey: `review:${policy.root}`,
      materials: [material],
    });
  }
  const decision = reconcilePipeline({
    ...fresh,
    evidence: {
      build,
      review: policy,
      checks: policy,
      qualification: fresh.queue.activeWarrant?.phase === "qualified",
    },
  });
  if (fresh.worker?.status === "in_progress")
    return { operation: "wait", reason: "native-worker-running" };
  if (
    ["reserve", "select", "qualify-native", "land"].includes(decision.operation)
  )
    return retainDeliveryRequest(fresh, session, build, host);
  return decision;
}
