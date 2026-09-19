import { businessAttempt, sourceGeneration } from "../attempt/identity.js";
import { attemptRecord } from "../attempt/records.js";
import { canonicalJson } from "../../release/discussion/envelope.js";
import { STOP_REQUESTED } from "./fence.js";

export function pipelineProgress(journal, { intent, writer, runtime }) {
  async function open(source, baseCommit, { successor = false } = {}) {
    const observed = await journal.read();
    const generation = sourceGeneration(intent, source, baseCommit);
    if (observed.attempt && observed.generation === generation.id && !successor)
      return observed;
    if (
      observed.attempt &&
      !["cancelled", "superseded", "failure", "complete"].includes(
        observed.status,
      )
    )
      throw new Error(
        "Prior attempt must reach terminal state before its successor opens",
      );
    const attempt = businessAttempt({
      intent,
      generation,
      predecessor: observed.attempt || "",
      requestKey: `source:${generation.id}`,
    });
    const root = attemptRecord({
      intent,
      attempt,
      generation,
      writer,
      runtime,
      eventKey: `open:${attempt.id}`,
      phase: "attempt",
      state: "running",
    });
    return journal.append(root, observed.head || "");
  }
  async function progress({
    attempt,
    phase,
    state,
    eventKey,
    reason = "",
    materials = [],
    expectedHead,
  }) {
    const observed = await journal.read();
    if (observed.attempt !== attempt)
      throw new Error("Late pipeline result belongs to a superseded attempt");
    if (expectedHead !== undefined && observed.head !== expectedHead)
      throw new Error(
        "Pipeline scheduling head changed; reobserve the active execution",
      );
    const current = observed.history.at(-1);
    if (
      state === "success" &&
      observed.phases[phase]?.payload.reason.startsWith(STOP_REQUESTED)
    )
      throw new Error("A stopped pipeline phase cannot report success");
    const duplicate = current.events.find(
      (event) => event.payload.eventKey === eventKey,
    );
    if (duplicate) {
      if (
        duplicate.node !== phase ||
        duplicate.payload.state !== state ||
        duplicate.payload.reason !== reason ||
        canonicalJson(duplicate.payload.materials) !== canonicalJson(materials)
      )
        throw new Error("Duplicate pipeline event changed its meaning");
      return observed;
    }
    const record = attemptRecord({
      intent,
      attempt: current.identity,
      generation: current.generation,
      writer,
      runtime,
      previous: current.events.at(-1),
      eventKey,
      phase,
      state,
      reason,
      materials,
    });
    return journal.append(record, observed.head);
  }
  async function requestStop(reason) {
    const observed = await journal.read();
    if (
      !observed.attempt ||
      ["complete", "cancelled", "failure", "superseded"].includes(
        observed.status,
      )
    )
      return observed;
    const phase = observed.missing[0];
    return progress({
      attempt: observed.attempt,
      phase,
      state: "waiting",
      eventKey: `stop:${observed.attempt}:${reason}`,
      reason: `${STOP_REQUESTED}${reason}`,
    });
  }
  return { open, progress, requestStop };
}
