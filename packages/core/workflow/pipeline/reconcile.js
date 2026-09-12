import { recordDigest } from "../../release/discussion/envelope.js";

const TERMINAL = new Set([
  "merged",
  "terminal-failure",
  "dequeued",
  "cancelled",
]);
const wait = (reason) => ({ operation: "wait", reason });

export function pipelineCandidateRoot(current) {
  if (
    !current.identity?.id ||
    current.identity.generation !== current.generation.id
  )
    throw new Error(
      "Pipeline candidate requires its exact business attempt identity",
    );
  return recordDigest({
    schema: "buildchain.pipeline-candidate-source/v1",
    intent: current.intent,
    attempt: current.identity,
    generation: current.generation,
  });
}

export function pipelineCandidate(queue, current) {
  const source = current.generation.source;
  const number = current.intent.source.pullRequest;
  const matches = queue.candidates.filter(
    (candidate) =>
      candidate.pullRequestNumber === number &&
      candidate.sourceHead === source.commit &&
      candidate.sourceRoot === pipelineCandidateRoot(current),
  );
  const active = matches.find(
    (candidate) => candidate.candidateId === queue.activeWarrant?.candidateId,
  );
  return active || matches.at(-1) || null;
}

function cancellation({
  candidate,
  queue,
  worker,
  reason,
  observedSourceHead,
}) {
  if (candidate && ["cancelled", "dequeued"].includes(candidate.status))
    return {
      operation: "record-cancellation",
      reason,
      candidateId: candidate.candidateId,
    };
  if (!candidate || TERMINAL.has(candidate.status))
    return { operation: "supersede", reason };
  if (candidate.candidateId !== queue.activeWarrant?.candidateId) {
    if (candidate.status !== "queued") return wait("unfenced-candidate-state");
    return {
      operation: "cancel-queued",
      reason,
      candidateId: candidate.candidateId,
      expectedSourceHead: candidate.sourceHead,
      observedSourceHead,
    };
  }
  // Expiration is not evidence that the old native worker stopped. Never
  // release or transfer an active Warrant until the provider proves terminality.
  if (!worker || worker.status !== "completed")
    return {
      operation: "stop-worker",
      reason: "active-worker-not-terminal",
      candidateId: candidate.candidateId,
    };
  return {
    operation: "settle-cancelled",
    reason,
    candidateId: candidate.candidateId,
  };
}

function sameSource(current, live) {
  if (!live.source) return false;
  return recordDigest(current.generation.source) === recordDigest(live.source);
}

function mergedDelivery(candidate, live, evidence) {
  if (!candidate) return wait("merged-candidate-authority-required");
  if (
    !evidence.integration ||
    evidence.integration.sourceHead !== live.source.commit
  )
    return wait("exact-protected-integration-proof-required");
  if (candidate.status !== "merged")
    return { operation: "settle-merged", reason: "protected-merge-observed" };
  if (
    !evidence.settlement ||
    evidence.settlement.candidateId !== candidate.candidateId
  )
    return wait("terminal-settlement-readback-required");
  return { operation: "wake-publication", reason: "delivery-terminal" };
}

// This pure planner selects the next domain transaction. Its booleans are
// authenticated provider readbacks at the adapter boundary, never workflow inputs.
// A selected operation is not a receipt or permission to skip that domain's gates.
export function reconcilePipeline({ current, live, queue, worker, evidence }) {
  if (
    queue.repository !== current.intent.repository ||
    queue.protectedBase !== current.intent.source.targetBranch ||
    live.pullRequest !== current.intent.source.pullRequest
  )
    throw new Error("Pipeline observation belongs to another intent");
  const candidate = pipelineCandidate(queue, current);
  const cancellationInput = {
    candidate,
    queue,
    worker,
    observedSourceHead: live.observedHead || live.source?.commit,
  };
  if (live.state === "closed" && !live.merged)
    return cancellation({
      ...cancellationInput,
      reason: "pull-request-closed",
    });
  if (
    live.targetBranch &&
    live.targetBranch !== current.intent.source.targetBranch
  )
    return cancellation({
      ...cancellationInput,
      reason: "target-branch-changed",
    });
  if (live.routeEnabled === false)
    return cancellation({
      ...cancellationInput,
      reason: "channel-policy-changed",
    });
  if (!sameSource(current, live))
    return cancellation({
      ...cancellationInput,
      reason: "source-generation-changed",
    });
  if (live.merged) return mergedDelivery(candidate, live, evidence);
  if (current.generation.baseCommit !== live.baseCommit)
    return cancellation({
      ...cancellationInput,
      reason: "protected-base-advanced",
    });
  if (live.dequeued === true)
    return cancellation({
      ...cancellationInput,
      reason: "pull-request-dequeued",
    });
  return openDelivery({ candidate, live, queue, worker, evidence });
}

function openDelivery({ candidate, live, queue, worker, evidence }) {
  if (live.state !== "open") return wait("unknown-provider-state");
  if (live.terminalOnly) return wait("terminal-event-cannot-start-execution");
  if (candidate && TERMINAL.has(candidate.status))
    return wait("successor-attempt-required");
  if (!evidence.build)
    return { operation: "build", reason: "source-needs-qualification" };
  if (evidence.build.sourceHead !== live.source.commit)
    throw new Error("Build evidence belongs to another source");
  if (evidence.build.outcome !== "success") {
    if (candidate && candidate.candidateId === queue.activeWarrant?.candidateId)
      return worker?.status === "completed"
        ? { operation: "settle-failure", reason: "native-execution-failed" }
        : { operation: "stop-worker", reason: "failed-worker-not-terminal" };
    return wait("build-failed");
  }
  if (!live.ready || live.draft) return wait("ready-review-required");
  if (!evidence.review) return wait("independent-protected-review-required");
  if (!evidence.checks) return wait("exact-required-checks-pending");
  if (!candidate) return { operation: "reserve", reason: "source-admitted" };
  if (candidate.candidateId !== queue.activeWarrant?.candidateId)
    return queue.activeWarrant
      ? wait("another-candidate-active")
      : { operation: "select", reason: "candidate-queued" };
  if (queue.activeWarrant.phase === "provisional")
    return {
      operation: "qualify-native",
      reason: "independent-native-proof-required",
    };
  if (!evidence.qualification)
    return wait("qualified-warrant-readback-required");
  return { operation: "land", reason: "protected-queue-admission" };
}
