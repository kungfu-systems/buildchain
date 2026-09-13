var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/core/workflow/attempt/reader-entry.js
var reader_entry_exports = {};
__export(reader_entry_exports, {
  readBusinessAttempt: () => readBusinessAttempt
});
module.exports = __toCommonJS(reader_entry_exports);
var import_node_fs = __toESM(require("fs"), 1);

// packages/core/release/discussion/envelope.js
var import_node_crypto = require("crypto");
var ENVELOPE_SCHEMA = "buildchain.discussion-record/v1";
var INTENT_SCHEMA = "buildchain.release-discussion/v1";
var PAYLOAD_SCHEMA = "buildchain.release-progress/v1";
var MARKER = "<!-- buildchain-transaction\n";
var MAX_RECORD_BYTES = 48e3;
function canonicalJson(value) {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Transaction numbers must be finite");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === void 0)
    throw new Error("Transaction records must contain JSON values");
  return encoded;
}
function recordDigest(value) {
  return `sha256:${(0, import_node_crypto.createHash)("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}
function validateRuntime(runtime) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(runtime?.repository || "") || !/^[a-f0-9]{40}$/u.test(runtime?.sha || "") || !/^sha256:[a-f0-9]{64}$/u.test(runtime?.readerDigest || ""))
    throw new Error(
      "Record requires selected runtime repository, exact revision and reader digest"
    );
  return runtime;
}
function encodeRecord(record, summary = "Buildchain release transaction record") {
  const body = `${summary}

${MARKER}${canonicalJson(record)}
-->`;
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES)
    throw new Error(
      "Transaction record exceeds the bounded body size; retain material as artifacts"
    );
  return body;
}
function decodeRecord(body) {
  if (typeof body !== "string" || !body.includes(MARKER)) return void 0;
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES)
    throw new Error("Oversized transaction record");
  const start = body.indexOf(MARKER) + MARKER.length;
  const end = body.indexOf("\n-->", start);
  if (end < 0 || body.indexOf(MARKER, start) >= 0)
    throw new Error("Malformed transaction envelope");
  const record = JSON.parse(body.slice(start, end));
  if (![ENVELOPE_SCHEMA, INTENT_SCHEMA].includes(record.schema))
    throw new Error("Unsupported transaction envelope schema");
  return record;
}
function createIntent({
  repository,
  key,
  expectedNodes,
  runtime,
  source
}) {
  requireString(repository, "Consumer repository");
  requireString(key, "Release intent key");
  if (key.length > 240 || /[\r\n<>]/u.test(key))
    throw new Error("Invalid release intent key");
  if (!Array.isArray(expectedNodes) || !expectedNodes.length || new Set(expectedNodes).size !== expectedNodes.length || expectedNodes.some((node) => !/^[a-z][a-z0-9-]*$/u.test(node)))
    throw new Error("Release intent requires unique expected semantic nodes");
  validateRuntime(runtime);
  const identity = { repository, key };
  return {
    schema: INTENT_SCHEMA,
    id: recordDigest(identity),
    ...identity,
    expectedNodes,
    organization: "attempt-threads/v1",
    runtime,
    source
  };
}
function createProgress({
  intent,
  attempt,
  predecessor = "",
  runtime,
  node,
  status,
  payload = {},
  sequence = 0,
  kind = "progress",
  writer = attempt
}) {
  validateRuntime(runtime);
  requireString(writer, "Record writer");
  requireString(attempt, "Workflow attempt");
  if (node !== "attempt" && !intent.expectedNodes.includes(node))
    throw new Error(`Undeclared release node: ${node}`);
  if (!["running", "success", "failure", "cancelled"].includes(status))
    throw new Error("Invalid release node status");
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error("Invalid record sequence");
  if (predecessor === attempt) throw new Error("Attempt cannot recover itself");
  if (!["progress", "checkpoint"].includes(kind))
    throw new Error("Invalid transaction record kind");
  const event = {
    kind,
    writer,
    schema: ENVELOPE_SCHEMA,
    intent: intent.id,
    attempt,
    predecessor,
    runtime,
    payloadSchema: PAYLOAD_SCHEMA,
    node,
    status,
    sequence,
    payload
  };
  return { ...event, id: recordDigest(event) };
}

// packages/core/release/discussion/reader.js
function readReleaseDiscussion({ body, records }) {
  const intent = decodeRecord(body);
  if (intent?.schema !== INTENT_SCHEMA)
    throw new Error("Missing release Discussion intent");
  if (intent.id !== recordDigest({ repository: intent.repository, key: intent.key }))
    throw new Error("Release intent identity mismatch");
  if (!Array.isArray(intent.expectedNodes) || !intent.expectedNodes.length || new Set(intent.expectedNodes).size !== intent.expectedNodes.length)
    throw new Error("Missing or duplicate expected nodes");
  if (intent.organization && intent.organization !== "attempt-threads/v1")
    throw new Error(
      "Discussion organization requires its historical runtime reader"
    );
  const attempts = groupAttempts(validateRecords(intent, records));
  if (!attempts.size)
    return {
      intent,
      status: "pending",
      attempts: [],
      missingNodes: intent.expectedNodes
    };
  const { head, lineage } = resolveLineage(attempts);
  const nodes = currentNodes(attempts.get(head).events);
  const missingNodes = intent.expectedNodes.filter((node) => !nodes[node]);
  const complete = intent.expectedNodes.every(
    (node) => nodes[node]?.status === "success"
  );
  const failed = Object.values(nodes).some(
    (event) => ["failure", "cancelled"].includes(event.status)
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
        (node) => nodes[node]?.status === "success"
      )
    }
  };
}
function validateRecords(intent, records) {
  const events = /* @__PURE__ */ new Map();
  for (const raw of records) {
    const event = typeof raw === "string" ? decodeRecord(raw) : raw;
    if (!event) continue;
    validateRuntime(event.runtime);
    if (!["progress", "checkpoint"].includes(event.kind) || !event.writer || !event.attempt || typeof event.predecessor !== "string")
      throw new Error("Invalid record ownership");
    const { id, ...content } = event;
    if (event.schema !== ENVELOPE_SCHEMA || event.payloadSchema !== PAYLOAD_SCHEMA)
      throw new Error("Record requires its historical runtime reader");
    if (event.intent !== intent.id || id !== recordDigest(content))
      throw new Error("Release record identity mismatch");
    if (event.node !== "attempt" && !intent.expectedNodes.includes(event.node))
      throw new Error("Undeclared release node");
    if (!["running", "success", "failure", "cancelled"].includes(event.status) || !Number.isSafeInteger(event.sequence) || event.sequence < 0)
      throw new Error("Invalid release progress");
    events.set(id, event);
  }
  return events;
}
function groupAttempts(events) {
  const attempts = /* @__PURE__ */ new Map();
  for (const event of events.values()) {
    const attempt = attempts.get(event.attempt) || {
      predecessor: event.predecessor,
      events: []
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
    [...attempts.values()].map((attempt) => attempt.predecessor).filter(Boolean)
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
  const nodes = {}, sequences = /* @__PURE__ */ new Map();
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

// packages/core/consumer/contract/shape.js
function object(value, required, optional = [], location = "config") {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`${location}: expected a table`);
  for (const key of Object.keys(value))
    if (![...required, ...optional].includes(key))
      throw new Error(`${location}.${key}: unknown field`);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new Error(`${location}.${key}: required field`);
  return value;
}
function text(value, location, pattern = /\S/u) {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("\0"))
    throw new Error(`${location}: invalid string`);
  return value;
}
function choice(value, choices, location) {
  if (!choices.includes(value))
    throw new Error(`${location}: expected ${choices.join(" or ")}`);
  return value;
}
function list(value, location, validate) {
  if (!Array.isArray(value) || !value.length)
    throw new Error(`${location}: expected a nonempty list`);
  return value.map((item, index) => validate(item, `${location}[${index}]`));
}
function unique(values, location) {
  if (new Set(values).size !== values.length)
    throw new Error(`${location}: duplicate identity`);
}
function relativePath(value, location) {
  text(value, location, /^[A-Za-z0-9_.][A-Za-z0-9_./*-]*$/u);
  if (value.split("/").some((part) => !part || part === ".." || part === "."))
    throw new Error(`${location}: expected a repository-relative path`);
  return value;
}

// packages/core/consumer/contract/plan.js
var CONSUMER_CONTRACT = "buildchain.consumer-contract/v2";

// packages/core/workflow/attempt/identity.js
var PIPELINE_PHASES = [
  "admission",
  "build",
  "review",
  "warrant",
  "merge",
  "publish",
  "distribution",
  "next-development"
];
var SOURCE_GENERATION = "buildchain.source-generation/v1";
var BUSINESS_ATTEMPT = "buildchain.business-attempt/v1";
var ROOT = /^sha256:[0-9a-f]{64}$/u;
function pipelineIntent({
  repository,
  repositoryId,
  pullRequest,
  targetBranch,
  phases,
  runtime
}) {
  text(repository, "repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  text(repositoryId, "repositoryId");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1)
    throw new Error("Invalid PR intent number");
  text(
    targetBranch,
    "targetBranch",
    /^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u
  );
  list(
    phases,
    "phases",
    (phase, field) => choice(phase, PIPELINE_PHASES, field)
  );
  unique(phases, "phases");
  if (phases.some(
    (phase, i) => i && PIPELINE_PHASES.indexOf(phase) <= PIPELINE_PHASES.indexOf(phases[i - 1])
  ))
    throw new Error("Intent phases must follow pipeline order");
  if (phases[0] !== "admission")
    throw new Error("Intent must begin with admission");
  return createIntent({
    repository,
    key: `pr-${pullRequest}:${targetBranch}`,
    expectedNodes: phases,
    runtime,
    source: { kind: "pipeline", repositoryId, pullRequest, targetBranch }
  });
}
function sourceGeneration(intent, source, baseCommit) {
  object(
    source,
    [
      "schema",
      "repository",
      "commit",
      "tree",
      "configPath",
      "configBlob",
      "configDigest",
      "contract"
    ],
    [],
    "source"
  );
  if (source.schema !== "buildchain.consumer-source/v1" || source.contract !== CONSUMER_CONTRACT || source.repository !== intent.repository)
    throw new Error("Generation requires the admitted consumer source");
  for (const key of ["commit", "tree", "configBlob"])
    text(source[key], `source.${key}`, /^[0-9a-f]{40}$/u);
  relativePath(source.configPath, "source.configPath");
  text(source.configDigest, "source.configDigest", ROOT);
  text(baseCommit, "baseCommit", /^[0-9a-f]{40}$/u);
  const value = {
    schema: SOURCE_GENERATION,
    intent: intent.id,
    source: structuredClone(source),
    baseCommit
  };
  return { ...value, id: recordDigest(value) };
}
function validateGeneration(value, intent) {
  object(
    value,
    ["schema", "intent", "source", "baseCommit", "id"],
    [],
    "generation"
  );
  const expected = sourceGeneration(intent, value.source, value.baseCommit);
  if (recordDigest(value) !== recordDigest(expected))
    throw new Error("Generation identity mismatch");
  return value;
}
function businessAttempt({
  intent,
  generation,
  predecessor = "",
  requestKey
}) {
  validateGeneration(generation, intent);
  text(requestKey, "requestKey");
  if (requestKey.length > 240)
    throw new Error("Attempt request key exceeds its bound");
  if (predecessor) text(predecessor, "predecessor", /^attempt-[0-9a-f]{64}$/u);
  const value = {
    schema: BUSINESS_ATTEMPT,
    intent: intent.id,
    generation: generation.id,
    predecessor,
    requestKey
  };
  return { ...value, id: `attempt-${recordDigest(value).slice(7)}` };
}
function validateAttempt(value, intent, generation) {
  object(
    value,
    ["schema", "intent", "generation", "predecessor", "requestKey", "id"],
    [],
    "attempt"
  );
  const expected = businessAttempt({
    intent,
    generation,
    predecessor: value.predecessor,
    requestKey: value.requestKey
  });
  if (recordDigest(value) !== recordDigest(expected))
    throw new Error("Business attempt identity mismatch");
  return value;
}
function providerWriter(value, repository) {
  object(value, ["repository", "runId", "runAttempt", "jobId"], [], "writer");
  if (value.repository !== repository)
    throw new Error("Writer belongs to a different repository");
  for (const key of ["runId", "runAttempt", "jobId"])
    text(value[key], `writer.${key}`, /^[1-9][0-9]*$/u);
  return `${value.runId}:${value.runAttempt}:${value.jobId}`;
}

// packages/core/workflow/attempt/materials.js
var import_node_crypto2 = require("crypto");
var MATERIAL_KINDS = [
  "artifact",
  "checkpoint",
  "receipt",
  "passport",
  "provider-readback"
];
function materialReference(value, attempt, repository = "") {
  object(
    value,
    ["id", "kind", "digest", "bytes", "url", "generation", "producerAttempt"],
    [],
    "material"
  );
  text(value.id, "material.id", /^[a-z][a-z0-9._/-]*$/u);
  choice(value.kind, MATERIAL_KINDS, "material.kind");
  text(value.digest, "material.digest", /^sha256:[0-9a-f]{64}$/u);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1)
    throw new Error("Invalid material byte size");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["github.com", "api.github.com"].includes(url.hostname))
    throw new Error(
      "Material must use a permanent GitHub URL without credentials or signed queries"
    );
  if (repository && !(url.hostname === "github.com" ? url.pathname.startsWith(`/${repository}/releases/download/`) || url.pathname.startsWith(`/${repository}/actions/runs/`) : url.pathname.startsWith(`/repos/${repository}/actions/artifacts/`) || url.pathname.startsWith(`/repos/${repository}/releases/assets/`)))
    throw new Error("Material belongs to another consumer repository");
  if (value.generation !== attempt.generation || value.producerAttempt !== attempt.id)
    throw new Error(
      "Material is not qualified for this exact attempt and generation"
    );
  return { ...value };
}
function indexMaterials(index, references, attempt) {
  for (const reference of references) {
    materialReference(reference, attempt);
    const old = index[reference.id];
    if (old && recordDigest(old) !== recordDigest(reference))
      throw new Error(`Immutable material identity conflict: ${reference.id}`);
    index[reference.id] = { ...reference };
  }
  return index;
}

// packages/core/workflow/attempt/records.js
var ATTEMPT_EVENT = "buildchain.business-attempt-event/v1";
var STATES = [
  "running",
  "waiting",
  "success",
  "failure",
  "cancelled",
  "superseded"
];
var ENVELOPE_STATUS = {
  running: "running",
  waiting: "running",
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  superseded: "cancelled"
};
function attemptRecord({
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
  materials = []
}) {
  validateAttempt(attempt, intent, generation);
  const writerId = providerWriter(writer, intent.repository);
  choice(state, STATES, "state");
  text(eventKey, "eventKey");
  if (eventKey.length > 240 || typeof reason !== "string" || reason.length > 2e3)
    throw new Error("Attempt event text exceeds its bound");
  if (!previous && (phase !== "attempt" || state !== "running"))
    throw new Error("Open an attempt root before phase progress");
  if (previous && (previous.attempt !== attempt.id || previous.payload.generation.id !== generation.id))
    throw new Error(
      "Record predecessor belongs to another attempt or generation"
    );
  if (!Array.isArray(materials) || materials.length > 100)
    throw new Error("Attempt event material bound exceeded");
  unique(
    materials.map((item) => item.id),
    "materials"
  );
  materials.forEach(
    (item) => materialReference(item, attempt, intent.repository)
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
      materials: structuredClone(materials)
    }
  });
}
function validateAttemptRecord(record, intent) {
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
      "materials"
    ],
    [],
    "attemptEvent"
  );
  if (value.schema !== ATTEMPT_EVENT)
    throw new Error("Attempt event requires its historical runtime reader");
  validateAttempt(value.identity, intent, value.generation);
  const { id, ...content } = record;
  if (id !== recordDigest(content) || record.attempt !== value.identity.id || record.intent !== intent.id || record.predecessor !== value.identity.predecessor)
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
    previous: value.previous ? {
      id: value.previous,
      attempt: record.attempt,
      payload: value,
      sequence: record.sequence - 1
    } : null,
    eventKey: value.eventKey,
    phase: record.node,
    state: value.state,
    reason: value.reason,
    materials: value.materials
  });
  if (recordDigest(expected) !== recordDigest(record))
    throw new Error("Invalid attempt record envelope");
  encodeRecord(record);
  return record;
}

// packages/core/workflow/attempt/reader.js
var MAX_ATTEMPT_RECORDS = 1e4;
var MAX_HISTORY_BYTES = 32 * 1024 * 1024;
function validateIntent(intent) {
  const source = intent.source;
  if (source?.kind !== "pipeline") throw new Error("Not a pipeline intent");
  const expected = pipelineIntent({
    ...source,
    repository: intent.repository,
    phases: intent.expectedNodes,
    runtime: intent.runtime
  });
  if (recordDigest(expected) !== recordDigest(intent))
    throw new Error("Pipeline intent identity mismatch");
}
function foldAttempt(events, intent) {
  events.sort((a, b) => a.sequence - b.sequence);
  const roots = events.filter((record) => record.node === "attempt");
  if (roots.length !== 1 || roots[0] !== events[0])
    throw new Error("Attempt requires exactly one initial root");
  const phases = /* @__PURE__ */ Object.create(null), materials = /* @__PURE__ */ Object.create(null), keys = /* @__PURE__ */ new Set(), runs = /* @__PURE__ */ new Map();
  let previous = null;
  for (const record of events) {
    const value = record.payload;
    if (value.identity.id !== roots[0].payload.identity.id || value.generation.id !== roots[0].payload.generation.id)
      throw new Error("Attempt changed its immutable generation");
    if (record.sequence !== (previous ? previous.sequence + 1 : 0) || value.previous !== (previous?.id || ""))
      throw new Error(
        "Attempt record chain has a gap, fork or missing predecessor"
      );
    if (keys.has(value.eventKey))
      throw new Error("Conflicting duplicate event key");
    keys.add(value.eventKey);
    if (record.node !== "attempt") {
      const before = intent.expectedNodes.slice(
        0,
        intent.expectedNodes.indexOf(record.node)
      );
      if (before.some((phase) => phases[phase]?.payload.state !== "success"))
        throw new Error("Phase predecessor has not succeeded");
      const old = phases[record.node];
      if (old && ["success", "failure", "cancelled", "superseded"].includes(
        old.payload.state
      ))
        throw new Error(
          "Terminal phase history is immutable; recover in a successor attempt"
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
    runs: [...runs.values()]
  };
}
function readBusinessAttempt({ intent, records }) {
  validateIntent(intent);
  if (!Array.isArray(records) || records.length > MAX_ATTEMPT_RECORDS)
    throw new Error("Attempt record count exceeds its bound");
  if (Buffer.byteLength(canonicalJson(records)) > MAX_HISTORY_BYTES)
    throw new Error("Attempt history byte bound exceeded");
  const unique2 = /* @__PURE__ */ new Map(), grouped = /* @__PURE__ */ new Map();
  for (const record of records) {
    validateAttemptRecord(record, intent);
    unique2.set(record.id, record);
  }
  for (const record of unique2.values()) {
    const events = grouped.get(record.attempt) || [];
    events.push(record);
    grouped.set(record.attempt, events);
  }
  const lineage = readReleaseDiscussion({
    body: encodeRecord(intent),
    records: [...unique2.values()]
  });
  const history = lineage.attempts.map(
    (id) => foldAttempt(grouped.get(id), intent)
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
      recovery: null
    };
  const missing = intent.expectedNodes.filter(
    (phase) => current.phases[phase]?.payload.state !== "success"
  );
  const states = Object.values(current.phases).map((record) => record.payload);
  const stopped = states.find(
    (value) => ["failure", "cancelled", "superseded"].includes(value.state)
  );
  const waiting = states.find((value) => value.state === "waiting");
  const status = stopped?.state || (missing.length ? waiting ? "waiting" : "running" : "complete");
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
    recovery: status === "complete" ? null : { attempt: current.identity.id }
  };
}

// packages/core/workflow/attempt/reader-entry.js
if (typeof require !== "undefined" && require.main === module) {
  const state = readBusinessAttempt(JSON.parse(import_node_fs.default.readFileSync(0, "utf8")));
  const { status, reason, attempt, generation, missing, recovery } = state;
  process.stdout.write(
    `${JSON.stringify({ status, reason, attempt, generation, missing, recovery })}
`
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  readBusinessAttempt
});
/*! Bundled license information:

smol-toml/dist/date.js:
smol-toml/dist/error.js:
smol-toml/dist/primitive.js:
smol-toml/dist/util.js:
smol-toml/dist/extract.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
