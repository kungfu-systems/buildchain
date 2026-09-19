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

// packages/core/release/discussion/reader-entry.js
var reader_entry_exports = {};
__export(reader_entry_exports, {
  decodeRecord: () => decodeRecord,
  readReleaseDiscussion: () => readReleaseDiscussion
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
function validateRuntime(runtime) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(runtime?.repository || "") || !/^[a-f0-9]{40}$/u.test(runtime?.sha || "") || !/^sha256:[a-f0-9]{64}$/u.test(runtime?.readerDigest || ""))
    throw new Error(
      "Record requires selected runtime repository, exact revision and reader digest"
    );
  return runtime;
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

// packages/core/release/discussion/reader-entry.js
if (typeof require !== "undefined" && require.main === module) {
  const input = JSON.parse(import_node_fs.default.readFileSync(0, "utf8"));
  process.stdout.write(`${JSON.stringify(readReleaseDiscussion(input))}
`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  decodeRecord,
  readReleaseDiscussion
});
