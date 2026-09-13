import {
  createProgress,
  recordDigest,
  encodeRecord,
} from "../../release/discussion/envelope.js";
import { object, text, choice, unique } from "../../consumer/contract/shape.js";
import { providerWriter, validateAttempt } from "./identity.js";
import { materialReference } from "./materials.js";

export const ATTEMPT_EVENT = "buildchain.business-attempt-event/v1";
export const STATES = [
  "running",
  "waiting",
  "success",
  "failure",
  "cancelled",
  "superseded",
];
const ENVELOPE_STATUS = {
  running: "running",
  waiting: "running",
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  superseded: "cancelled",
};

export function attemptRecord({
  intent,
  attempt,
  generation,
  writer,
  runtime,
  previous = null,
  eventKey,
  phase,
  state,
  reason = "",
  materials = [],
}) {
  validateAttempt(attempt, intent, generation);
  const writerId = providerWriter(writer, intent.repository);
  choice(state, STATES, "state");
  text(eventKey, "eventKey");
  if (
    eventKey.length > 240 ||
    typeof reason !== "string" ||
    reason.length > 2000
  )
    throw new Error("Attempt event text exceeds its bound");
  if (!previous && (phase !== "attempt" || state !== "running"))
    throw new Error("Open an attempt root before phase progress");
  if (
    previous &&
    (previous.attempt !== attempt.id ||
      previous.payload.generation.id !== generation.id)
  )
    throw new Error(
      "Record predecessor belongs to another attempt or generation",
    );
  if (!Array.isArray(materials) || materials.length > 100)
    throw new Error("Attempt event material bound exceeded");
  unique(
    materials.map((item) => item.id),
    "materials",
  );
  materials.forEach((item) =>
    materialReference(item, attempt, intent.repository),
  );
  return createProgress({
    intent,
    attempt: attempt.id,
    predecessor: attempt.predecessor,
    writer: writerId,
    runtime,
    node: phase,
    status: ENVELOPE_STATUS[state],
    sequence: previous ? previous.sequence + 1 : 0,
    payload: {
      schema: ATTEMPT_EVENT,
      identity: attempt,
      generation,
      writer: { ...writer },
      previous: previous?.id || "",
      eventKey,
      state,
      reason,
      materials: structuredClone(materials),
    },
  });
}

export function validateAttemptRecord(record, intent) {
  const value = record.payload;
  object(
    value,
    [
      "schema",
      "identity",
      "generation",
      "writer",
      "previous",
      "eventKey",
      "state",
      "reason",
      "materials",
    ],
    [],
    "attemptEvent",
  );
  if (value.schema !== ATTEMPT_EVENT)
    throw new Error("Attempt event requires its historical runtime reader");
  validateAttempt(value.identity, intent, value.generation);
  const { id, ...content } = record;
  if (
    id !== recordDigest(content) ||
    record.attempt !== value.identity.id ||
    record.intent !== intent.id ||
    record.predecessor !== value.identity.predecessor
  )
    throw new Error("Attempt record identity mismatch");
  if (providerWriter(value.writer, intent.repository) !== record.writer)
    throw new Error("Attempt provider writer mismatch");
  choice(value.state, STATES, "attemptEvent.state");
  if (record.status !== ENVELOPE_STATUS[value.state])
    throw new Error("Attempt record status mismatch");
  if (value.previous)
    text(value.previous, "previous", /^sha256:[0-9a-f]{64}$/u);
  const expected = attemptRecord({
    intent,
    attempt: value.identity,
    generation: value.generation,
    writer: value.writer,
    runtime: record.runtime,
    previous: value.previous
      ? {
          id: value.previous,
          attempt: record.attempt,
          payload: value,
          sequence: record.sequence - 1,
        }
      : null,
    eventKey: value.eventKey,
    phase: record.node,
    state: value.state,
    reason: value.reason,
    materials: value.materials,
  });
  if (recordDigest(expected) !== recordDigest(record))
    throw new Error("Invalid attempt record envelope");
  encodeRecord(record);
  return record;
}
