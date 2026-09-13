import { recordDigest } from "../../release/discussion/envelope.js";
import { settleRecoveryOwnership } from "./recovery-ownership-settlement.js";
import { retainedRecoveryEvidence } from "./recovery-session.js";

export async function qualifyRecoveryIntegration(session, admission, host) {
  const current = {
    ...session.observed.history.at(-1),
    intent: session.intent,
  };
  const integration = await host.integration.observe(current);
  const review = await host.policy.observeMerged(
    current,
    admission.protectedPlan.review,
    integration,
  );
  if (!review.review || !review.checksPassing)
    throw new Error(
      "Recovery of protected integration requires current exact review and required checks",
    );
  return { integration, review };
}

async function replayPhase(session, phase, value, host) {
  const observed = await session.journal.read();
  const old = observed.phases[phase];
  if (old?.payload.state === "success") return;
  const root = recordDigest(value);
  const reference = await host
    .materialStore(session)
    .retain(`recovery/${phase}-${root.slice(7)}`, value, "provider-readback");
  await session.progress.progress({
    attempt: observed.attempt,
    phase,
    state: "success",
    eventKey: `recovery-${phase}:${root}`,
    materials: [reference],
    expectedHead: observed.head,
  });
}

export async function replayRecoveryIntegration(session, host) {
  session.observed = await session.journal.read();
  const { evidence } = await retainedRecoveryEvidence(session, host);
  if (!evidence.admitted.admission.live.merged) return;
  const qualified = await qualifyRecoveryIntegration(
    session,
    evidence.admitted.admission,
    host,
  );
  await replayPhase(session, "review", qualified.review, host);
  if (session.intent.expectedNodes.includes("warrant")) {
    const ownership = await settleRecoveryOwnership(session, qualified, host);
    await replayPhase(
      session,
      "warrant",
      {
        schema: "buildchain.pipeline-recovery-merged-warrant/v1",
        candidate: ownership.candidate,
        proof: ownership.proof,
        predecessor: evidence.ownership.ownerAttempt,
      },
      host,
    );
  }
  await replayPhase(session, "merge", qualified.integration, host);
}
