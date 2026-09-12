import { createHash } from "node:crypto";

export const ENVELOPE_SCHEMA = "buildchain.discussion-record/v1";
export const INTENT_SCHEMA = "buildchain.release-discussion/v1";
export const PAYLOAD_SCHEMA = "buildchain.release-progress/v1";
const MARKER = "<!-- buildchain-transaction\n";
export const MAX_RECORD_BYTES = 48_000;

export function canonicalJson(value) {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Transaction numbers must be finite");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Transaction records must contain JSON values");
  return encoded;
}

export function recordDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function requireString(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is required`);
  return value;
}

export function validateRuntime(runtime) {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(runtime?.repository || "") ||
    !/^[a-f0-9]{40}$/u.test(runtime?.sha || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(runtime?.readerDigest || "")
  )
    throw new Error(
      "Record requires selected runtime repository, exact revision and reader digest",
    );
  return runtime;
}

export function encodeRecord(
  record,
  summary = "Buildchain release transaction record",
) {
  const body = `${summary}\n\n${MARKER}${canonicalJson(record)}\n-->`;
  if (Buffer.byteLength(body) > MAX_RECORD_BYTES)
    throw new Error(
      "Transaction record exceeds the bounded body size; retain material as artifacts",
    );
  return body;
}

export function decodeRecord(body) {
  if (typeof body !== "string" || !body.includes(MARKER)) return undefined;
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

export function createIntent({
  repository,
  key,
  expectedNodes,
  runtime,
  source,
}) {
  requireString(repository, "Consumer repository");
  requireString(key, "Release intent key");
  if (key.length > 240 || /[\r\n<>]/u.test(key))
    throw new Error("Invalid release intent key");
  if (
    !Array.isArray(expectedNodes) ||
    !expectedNodes.length ||
    new Set(expectedNodes).size !== expectedNodes.length ||
    expectedNodes.some((node) => !/^[a-z][a-z0-9-]*$/u.test(node))
  )
    throw new Error("Release intent requires unique expected semantic nodes");
  validateRuntime(runtime);
  const identity = { repository, key };
  return {
    schema: INTENT_SCHEMA,
    id: recordDigest(identity),
    ...identity,
    expectedNodes,
    runtime,
    source,
  };
}

export function createProgress({
  intent,
  attempt,
  predecessor = "",
  runtime,
  node,
  status,
  payload = {},
  sequence = 0,
  kind = "progress",
  writer = attempt,
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
    payload,
  };
  return { ...event, id: recordDigest(event) };
}
