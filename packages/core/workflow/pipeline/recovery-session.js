import { readBusinessAttempt } from "../attempt/reader.js";
import { atomicAttemptJournal } from "../attempt/journal.js";
import { businessAttempt } from "../attempt/identity.js";
import { attemptRecord } from "../attempt/records.js";
import { pipelineProgress } from "./progress.js";
import { recoveryRequestKey, verifyRecoveryPlan } from "./recovery-plan.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export async function selectRecoveryAttempt(attempt, host, entry) {
  const loaded = await host.index.resolve(attempt);
  const journal = atomicAttemptJournal(host.provider, loaded.snapshot.intent);
  const observed = await journal.read();
  if (observed.intent.repository !== host.repository)
    throw new Error("Recovery cannot cross consumer repositories");
  const selected = observed.history.find(
    (item) => item.identity.id === attempt,
  );
  if (!selected)
    throw new Error("Recovery attempt is absent from canonical history");
  const key = recoveryRequestKey(attempt, host.runtime, entry);
  const current = observed.history.at(-1);
  const duplicate = current.identity.id !== attempt;
  if (
    duplicate &&
    (current.identity.predecessor !== attempt ||
      current.identity.requestKey !== key)
  )
    throw new Error(
      `Historical recovery cannot fork current ownership; select ${current.identity.id}`,
    );
  return {
    intent: observed.intent,
    journal,
    observed,
    selected,
    duplicate,
    progress: pipelineProgress(journal, { intent: observed.intent, ...host }),
  };
}

export async function openRecoveryAttempt(session, plan, host, evidence) {
  const observed = await session.journal.read();
  verifyRecoveryPlan(plan, observed);
  if (recordDigest(plan.runtime) !== recordDigest(host.runtime))
    throw new Error("Recovery executor differs from the admitted runtime");
  if (evidence === undefined || recordDigest(evidence) !== plan.evidenceRoot)
    throw new Error(
      "Recovery requires the actual qualified evidence bound by its plan",
    );
  const generation = observed.history.at(-1).generation;
  const identity = businessAttempt({
    intent: session.intent,
    generation,
    predecessor: observed.attempt,
    requestKey: plan.requestKey,
  });
  const pending = {
    ...session,
    observed: { ...observed, history: [{ identity, generation }] },
  };
  const reference = await host
    .materialStore(pending)
    .retain("recovery/admission", plan);
  const evidenceReference = await host
    .materialStore(pending)
    .retain("recovery/evidence", evidence);
  const root = attemptRecord({
    intent: session.intent,
    attempt: identity,
    generation,
    writer: host.writer,
    runtime: host.runtime,
    eventKey: `open:${identity.id}`,
    phase: "attempt",
    state: "running",
    reason:
      "Explicit recovery; completed effects remain immutable in predecessor history",
    materials: [reference, evidenceReference],
  });
  const opened = await session.journal.append(root, observed.head);
  await host.index.retain(session.intent, identity.id);
  return {
    ...session,
    observed: opened,
    duplicate: false,
    progress: pipelineProgress(session.journal, {
      intent: session.intent,
      ...host,
    }),
  };
}

export async function retainedRecoveryPlan(session, host) {
  const current = session.observed.history.at(-1);
  const references = current.events[0].payload.materials.filter(
    (item) => item.id === "recovery/admission",
  );
  if (references.length !== 1)
    throw new Error("Recovery successor has no unique retained admission plan");
  const plan = await host.materialStore(session).read(references[0]);
  const records = session.observed.snapshot.records.filter((record) =>
    session.observed.history
      .slice(0, -1)
      .some((item) => item.identity.id === record.attempt),
  );
  const predecessor = readBusinessAttempt({ intent: session.intent, records });
  verifyRecoveryPlan(plan, predecessor);
  if (
    current.identity.predecessor !== plan.predecessor ||
    current.identity.requestKey !== plan.requestKey
  )
    throw new Error("Recovery successor does not bind its immutable admission");
  return plan;
}

export async function retainedRecoveryEvidence(session, host) {
  const plan = await retainedRecoveryPlan(session, host);
  const references = session.observed.history
    .at(-1)
    .events[0].payload.materials.filter(
      (item) => item.id === "recovery/evidence",
    );
  if (references.length !== 1)
    throw new Error("Recovery successor lacks its unique qualified evidence");
  const evidence = await host.materialStore(session).read(references[0]);
  if (recordDigest(evidence) !== plan.evidenceRoot)
    throw new Error("Recovery evidence differs from its immutable admission");
  return { plan, evidence };
}
