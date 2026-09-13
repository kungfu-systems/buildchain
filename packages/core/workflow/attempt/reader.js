import {
  canonicalJson,
  encodeRecord,
  recordDigest,
} from "../../release/discussion/envelope.js";
import { readReleaseDiscussion } from "../../release/discussion/reader.js";
import { pipelineIntent } from "./identity.js";
import { validateAttemptRecord } from "./records.js";
import { indexMaterials } from "./materials.js";

export const MAX_ATTEMPT_RECORDS = 10_000;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

function validateIntent(intent) {
  const source = intent.source;
  if (source?.kind !== "pipeline") throw new Error("Not a pipeline intent");
  const expected = pipelineIntent({
    ...source,
    repository: intent.repository,
    phases: intent.expectedNodes,
    runtime: intent.runtime,
  });
  if (recordDigest(expected) !== recordDigest(intent))
    throw new Error("Pipeline intent identity mismatch");
}

function foldAttempt(events, intent) {
  events.sort((a, b) => a.sequence - b.sequence);
  const roots = events.filter((record) => record.node === "attempt");
  if (roots.length !== 1 || roots[0] !== events[0])
    throw new Error("Attempt requires exactly one initial root");
  const phases = Object.create(null),
    materials = Object.create(null),
    keys = new Set(),
    runs = new Map();
  let previous = null;
  for (const record of events) {
    const value = record.payload;
    if (
      value.identity.id !== roots[0].payload.identity.id ||
      value.generation.id !== roots[0].payload.generation.id
    )
      throw new Error("Attempt changed its immutable generation");
    if (
      record.sequence !== (previous ? previous.sequence + 1 : 0) ||
      value.previous !== (previous?.id || "")
    )
      throw new Error(
        "Attempt record chain has a gap, fork or missing predecessor",
      );
    if (keys.has(value.eventKey))
      throw new Error("Conflicting duplicate event key");
    keys.add(value.eventKey);
    if (record.node !== "attempt") {
      const before = intent.expectedNodes.slice(
        0,
        intent.expectedNodes.indexOf(record.node),
      );
      if (before.some((phase) => phases[phase]?.payload.state !== "success"))
        throw new Error("Phase predecessor has not succeeded");
      const old = phases[record.node];
      if (
        old &&
        ["success", "failure", "cancelled", "superseded"].includes(
          old.payload.state,
        )
      )
        throw new Error(
          "Terminal phase history is immutable; recover in a successor attempt",
        );
      phases[record.node] = record;
    }
    indexMaterials(materials, value.materials, value.identity);
    runs.set(record.writer, value.writer);
    previous = record;
  }
  return {
    identity: roots[0].payload.identity,
    generation: roots[0].payload.generation,
    head: previous.id,
    events,
    phases,
    materials,
    runs: [...runs.values()],
  };
}

// This projection is evidence navigation, never a Warrant or publication authorization.
export function readBusinessAttempt({ intent, records }) {
  validateIntent(intent);
  if (!Array.isArray(records) || records.length > MAX_ATTEMPT_RECORDS)
    throw new Error("Attempt record count exceeds its bound");
  if (Buffer.byteLength(canonicalJson(records)) > MAX_HISTORY_BYTES)
    throw new Error("Attempt history byte bound exceeded");
  const unique = new Map(),
    grouped = new Map();
  for (const record of records) {
    validateAttemptRecord(record, intent);
    unique.set(record.id, record);
  }
  for (const record of unique.values()) {
    const events = grouped.get(record.attempt) || [];
    events.push(record);
    grouped.set(record.attempt, events);
  }
  const lineage = readReleaseDiscussion({
    body: encodeRecord(intent),
    records: [...unique.values()],
  });
  const history = lineage.attempts.map((id) =>
    foldAttempt(grouped.get(id), intent),
  );
  const current = history.at(-1);
  if (!current)
    return {
      intent,
      status: "pending",
      reason: "not-admitted",
      attempt: "",
      missing: intent.expectedNodes,
      history,
      recovery: null,
    };
  const missing = intent.expectedNodes.filter(
    (phase) => current.phases[phase]?.payload.state !== "success",
  );
  const states = Object.values(current.phases).map((record) => record.payload);
  const stopped = states.find((value) =>
    ["failure", "cancelled", "superseded"].includes(value.state),
  );
  const waiting = states.find((value) => value.state === "waiting");
  const status =
    stopped?.state ||
    (missing.length ? (waiting ? "waiting" : "running") : "complete");
  return {
    intent,
    attempt: current.identity.id,
    generation: current.generation.id,
    status,
    reason: stopped?.reason || waiting?.reason || status,
    head: current.head,
    missing,
    phases: current.phases,
    materials: current.materials,
    runs: current.runs,
    history,
    recovery: status === "complete" ? null : { attempt: current.identity.id },
  };
}
