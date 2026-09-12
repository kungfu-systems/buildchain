import {
  ENVELOPE_SCHEMA,
  INTENT_SCHEMA,
  PAYLOAD_SCHEMA,
  decodeRecord,
  recordDigest,
  validateRuntime,
} from "./envelope.js";

// Pure historical reader: no provider access, writes or effect recovery.
export function readReleaseDiscussion({ body, records }) {
  const intent = decodeRecord(body);
  if (intent?.schema !== INTENT_SCHEMA)
    throw new Error("Missing release Discussion intent");
  if (
    intent.id !==
    recordDigest({ repository: intent.repository, key: intent.key })
  )
    throw new Error("Release intent identity mismatch");
  if (
    !Array.isArray(intent.expectedNodes) ||
    !intent.expectedNodes.length ||
    new Set(intent.expectedNodes).size !== intent.expectedNodes.length
  )
    throw new Error("Missing or duplicate expected nodes");
  const attempts = groupAttempts(validateRecords(intent, records));
  if (!attempts.size)
    return {
      intent,
      status: "pending",
      attempts: [],
      missingNodes: intent.expectedNodes,
    };
  const { head, lineage } = resolveLineage(attempts);
  const nodes = currentNodes(attempts.get(head).events);
  const missingNodes = intent.expectedNodes.filter((node) => !nodes[node]);
  const complete = intent.expectedNodes.every(
    (node) => nodes[node]?.status === "success",
  );
  const failed = Object.values(nodes).some((event) =>
    ["failure", "cancelled"].includes(event.status),
  );
  return {
    intent,
    attempt: head,
    attempts: lineage.reverse(),
    nodes,
    missingNodes,
    status: complete ? "complete" : failed ? "failed" : "running",
    handoff: {
      schema: "buildchain.release-handoff/v1",
      intent: intent.id,
      predecessor: head,
      completedNodes: intent.expectedNodes.filter(
        (node) => nodes[node]?.status === "success",
      ),
    },
  };
}

function validateRecords(intent, records) {
  const events = new Map();
  for (const raw of records) {
    const event = typeof raw === "string" ? decodeRecord(raw) : raw;
    if (!event) continue;
    validateRuntime(event.runtime);
    if (
      !["progress", "checkpoint"].includes(event.kind) ||
      !event.writer ||
      !event.attempt ||
      typeof event.predecessor !== "string"
    )
      throw new Error("Invalid record ownership");
    const { id, ...content } = event;
    if (
      event.schema !== ENVELOPE_SCHEMA ||
      event.payloadSchema !== PAYLOAD_SCHEMA
    )
      throw new Error("Record requires its historical runtime reader");
    if (event.intent !== intent.id || id !== recordDigest(content))
      throw new Error("Release record identity mismatch");
    if (event.node !== "attempt" && !intent.expectedNodes.includes(event.node))
      throw new Error("Undeclared release node");
    if (
      !["running", "success", "failure", "cancelled"].includes(event.status) ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0
    )
      throw new Error("Invalid release progress");
    events.set(id, event);
  }
  return events;
}

function groupAttempts(events) {
  const attempts = new Map();
  for (const event of events.values()) {
    const attempt = attempts.get(event.attempt) || {
      predecessor: event.predecessor,
      events: [],
    };
    if (attempt.predecessor !== event.predecessor)
      throw new Error("Conflicting workflow attempt identity");
    attempt.events.push(event);
    attempts.set(event.attempt, attempt);
  }
  return attempts;
}

function resolveLineage(attempts) {
  const predecessors = new Set(
    [...attempts.values()]
      .map((attempt) => attempt.predecessor)
      .filter(Boolean),
  );
  for (const predecessor of predecessors)
    if (!attempts.has(predecessor))
      throw new Error("Recovery predecessor is missing");
  const heads = [...attempts.keys()].filter((id) => !predecessors.has(id));
  if (heads.length !== 1)
    throw new Error("Release attempt succession is ambiguous or cyclic");
  const lineage = [];
  let current = heads[0];
  while (current) {
    if (lineage.includes(current)) throw new Error("Cyclic recovery chain");
    lineage.push(current);
    current = attempts.get(current).predecessor;
  }
  if (lineage.length !== attempts.size)
    throw new Error("Disconnected recovery chain");
  return { head: heads[0], lineage };
}

function currentNodes(events) {
  const nodes = {},
    sequences = new Map();
  // Reuse is explicit and independently qualified by the recovering runtime.
  for (const event of events) {
    if (event.kind === "checkpoint") continue;
    const key = `${event.node}:${event.sequence}`;
    if (sequences.has(key) && sequences.get(key) !== event.id)
      throw new Error("Conflicting node progress at the same sequence");
    sequences.set(key, event.id);
    const old = nodes[event.node];
    if (!old || old.sequence < event.sequence) nodes[event.node] = event;
  }
  return nodes;
}

// Workflow outputs carry a bounded projection, never the complete comment log.
export function discussionStatus(state) {
  return {
    discussionId: state.discussion.id,
    discussionUrl: state.discussion.url,
    intent: state.intent.id,
    status: state.status,
    attempt: state.attempt || "",
    attempts: state.attempts,
    missingNodes: state.missingNodes,
    handoff: state.handoff || null,
    nodes: Object.fromEntries(
      Object.entries(state.nodes || {}).map(([node, record]) => [
        node,
        { status: record.status, recordId: record.id, writer: record.writer },
      ]),
    ),
  };
}
