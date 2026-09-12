import { recordDigest } from "../../release/discussion/envelope.js";
import { planPipelineRecovery } from "./recovery-plan.js";
import { settleRecoveryOwnership } from "./recovery-ownership-settlement.js";
import { qualifyRecoveryIntegration } from "./recovery-integration.js";
import { retainedRecoveryEvidence } from "./recovery-session.js";

export async function terminateRecoveryPredecessor(
  session,
  executions,
  ownership,
  host,
) {
  const observed = await session.journal.read();
  if (observed.head !== session.observed.head || !executions.terminal)
    throw new Error(
      "Recovery predecessor advanced after terminal execution readback",
    );
  if (["failure", "cancelled", "superseded"].includes(observed.status))
    return session;
  if (observed.status === "complete")
    throw new Error("Completed attempt has no recovery work");
  const evidence = { executions, ownership };
  const material = await host
    .materialStore(session)
    .retain("recovery/predecessor-terminal", evidence, "provider-readback");
  const after = await session.progress.progress({
    attempt: observed.attempt,
    phase: observed.missing[0],
    state: "cancelled",
    eventKey: `recovery-terminal:${recordDigest(evidence)}`,
    reason:
      "Explicit recovery after provider executions became terminal; native ownership remains fenced until successor admission",
    materials: [material],
    expectedHead: observed.head,
  });
  return { ...session, observed: after };
}

export function recoveryNodePlan(session, evidence, entry, host) {
  const cleanup = Boolean(evidence.ownership?.candidate);
  const nodes = session.intent.expectedNodes.map((phase) => {
    if (phase === "admission")
      return {
        phase,
        operation: cleanup ? "reconcile" : "reuse",
        reason:
          "Exact original source and protected route independently reobserved",
        evidenceRoots: [recordDigest(evidence.admitted)],
      };
    if (phase === "build")
      return {
        phase,
        operation: evidence.build.scheduled.length
          ? "execute"
          : cleanup
            ? "reconcile"
            : "reuse",
        reason: evidence.build.reason,
        evidenceRoots: [evidence.build.root],
      };
    return {
      phase,
      operation: "reconcile",
      reason:
        "Reobserve protected provider authority and execute remaining work",
      evidenceRoots: [],
    };
  });
  return planPipelineRecovery({
    observed: session.observed,
    runtime: host.runtime,
    entry,
    nodes,
    evidenceRoot: recordDigest(evidence),
  });
}

export async function replayRecoveryAdmission(session, host) {
  session.observed = await session.journal.read();
  const { plan, evidence } = await retainedRecoveryEvidence(session, host);
  const value = {
    schema: "buildchain.pipeline-recovery-source/v1",
    recoveryPlanRoot: plan.root,
    predecessor: plan.predecessor,
    source: evidence.admitted.source.identity,
    admission: evidence.admitted.admission,
    caller: evidence.admitted.caller,
  };
  const prior = session.observed.phases.admission;
  if (prior?.payload.state === "success") {
    if (
      prior.payload.state !== "success" ||
      prior.payload.materials.length !== 1 ||
      recordDigest(
        sourceFields(
          await host.materialStore(session).read(prior.payload.materials[0]),
        ),
      ) !== recordDigest(value)
    )
      throw new Error(
        "Recovery admission replay differs from its immutable source qualification",
      );
    return session;
  }
  const qualified = evidence.admitted.admission.live.merged
    ? await qualifyRecoveryIntegration(
        session,
        evidence.admitted.admission,
        host,
      )
    : null;
  const ownership = await settleRecoveryOwnership(session, qualified, host);
  const reference = await host
    .materialStore(session)
    .retain(
      "source/recovery-admission",
      { ...value, ownership },
      "provider-readback",
    );
  await session.progress.progress({
    attempt: session.observed.attempt,
    phase: "admission",
    state: "success",
    eventKey: `recovery-source:${plan.root}`,
    materials: [reference],
    expectedHead: session.observed.head,
  });
  session.observed = await session.journal.read();
  return session;
}

function sourceFields(value) {
  const { ownership, ...source } = value;
  return source;
}
