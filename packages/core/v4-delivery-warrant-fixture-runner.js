import { TextDecoder } from "node:util";

import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
  validateV4ContractFault,
  validateV4EventEnvelope,
  validateV4ReceiptEnvelope,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_DELIVERY_WARRANT_TRACE_CONTRACT =
  "buildchain-v4-delivery-warrant-trace-fixture/v1";
export const V4_DELIVERY_WARRANT_RUNNER_CONTRACT =
  "buildchain-v4-delivery-warrant-fixture-runner/v1";
export const V4_DELIVERY_WARRANT_PROJECTION_CONTRACT =
  "buildchain-v4-delivery-warrant-semantic-projection/v1";

const ASCII_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function fail(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-object", path, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail("invalid-trace-shape", path, `${path} keys are not canonical`);
}

function token(value, path) {
  if (typeof value !== "string" || !ASCII_TOKEN_PATTERN.test(value))
    fail("invalid-trace-token", path, `${path} must be an ASCII token`);
  return value;
}

function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail(
      "invalid-trace-integer",
      path,
      `${path} must be a non-negative safe integer`,
    );
  return value;
}

function equalCanonical(left, right) {
  return v4CanonicalBytes(left).equals(v4CanonicalBytes(right));
}

function declaredRoot(value, expected, path, code) {
  validateV4Root(value, path);
  if (value !== expected)
    fail(code, path, `${path} does not match the retained canonical bytes`);
  return value;
}

function readBytes(bytes) {
  const input = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : typeof bytes === "string"
        ? Buffer.from(bytes, "utf8")
        : fail(
            "invalid-trace-bytes",
            "$",
            "trace input must be UTF-8 bytes or a string",
          );
  if (input.length === 0 || input.at(-1) !== 0x0a)
    fail(
      "invalid-trace-bytes",
      "$",
      "retained trace bytes must end with one LF",
    );
  if (
    input.length >= 3 &&
    input[0] === 0xef &&
    input[1] === 0xbb &&
    input[2] === 0xbf
  )
    fail("invalid-trace-bytes", "$", "retained trace bytes must not use BOM");
  let text;
  try {
    text = UTF8.decode(input);
  } catch {
    fail("invalid-trace-bytes", "$", "retained trace bytes are not UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid-trace-json", "$", "retained trace bytes are not JSON");
  }
}

function validateOrderedEntries(entries, path) {
  if (!Array.isArray(entries))
    fail("invalid-trace-shape", path, `${path} must be an array`);
  return entries.map((entry, index) => {
    exactKeys(entry, ["sequence", "type", "payload"], `${path}/${index}`);
    if (entry.sequence !== index)
      fail(
        "reordered-trace",
        `${path}/${index}/sequence`,
        `${path} sequence must be contiguous and ordered`,
      );
    token(entry.type, `${path}/${index}/type`);
    v4CanonicalBytes(entry.payload);
    return entry;
  });
}

function validateState(state, path) {
  exactKeys(
    state,
    ["schema", "generation", "fencingCounter", "activeWarrant", "candidates"],
    path,
  );
  if (state.schema !== "buildchain-v4-delivery-warrant-state/v1")
    fail(
      "unsupported-trace-version",
      `${path}/schema`,
      "unsupported Delivery Warrant state schema",
    );
  const generation = nonNegativeInteger(state.generation, `${path}/generation`);
  const fencingCounter = nonNegativeInteger(
    state.fencingCounter,
    `${path}/fencingCounter`,
  );
  if (!Array.isArray(state.candidates))
    fail(
      "invalid-trace-shape",
      `${path}/candidates`,
      "state candidates must be an array",
    );
  const canonicalUtf8 = v4CanonicalBytes(state).toString("utf8");
  return {
    generation,
    fencingCounter,
    canonicalUtf8,
    root: v4ContentRoot("queue-state", state),
  };
}

function validateDecision(decision, receipt, path) {
  exactKeys(decision, ["action", "fault"], path);
  const hasAction = decision.action !== null;
  const hasFault = decision.fault !== null;
  if (hasAction === hasFault)
    fail(
      "invalid-trace-decision",
      path,
      "decision must contain exactly one action or typed fault",
    );
  if (hasAction) {
    token(decision.action, `${path}/action`);
    if (receipt.outcome === "rejected" || receipt.fault !== null)
      fail(
        "invalid-trace-decision",
        path,
        "an action cannot bind a rejected receipt",
      );
  } else {
    validateV4ContractFault(decision.fault, `${path}/fault`);
    if (
      receipt.outcome !== "rejected" ||
      receipt.fault === null ||
      !equalCanonical(decision.fault, receipt.fault)
    )
      fail(
        "invalid-trace-decision",
        path,
        "typed fault and rejected receipt must match exactly",
      );
  }
  return decision;
}

function projectStep(step, index, priorStateRoot) {
  const path = `$/trace/steps/${index}`;
  exactKeys(
    step,
    [
      "sequence",
      "id",
      "operation",
      "event",
      "decision",
      "priorStateRoot",
      "successorState",
      "successorRoot",
      "effects",
      "observations",
      "receipt",
      "receiptRoot",
    ],
    path,
  );
  if (step.sequence !== index)
    fail(
      "reordered-trace",
      `${path}/sequence`,
      "trace step sequence must be contiguous and ordered",
    );
  token(step.id, `${path}/id`);
  token(step.operation, `${path}/operation`);
  declaredRoot(
    step.priorStateRoot,
    priorStateRoot,
    `${path}/priorStateRoot`,
    "stale-prior-root",
  );

  validateV4EventEnvelope(step.event);
  if (step.event.subjectRoot !== priorStateRoot)
    fail(
      "stale-prior-root",
      `${path}/event/subjectRoot`,
      "event subjectRoot must bind the exact prior state",
    );
  const eventRoot = v4ContentRoot("observation", step.event);

  const successor = validateState(
    step.successorState,
    `${path}/successorState`,
  );
  const successorRoot = declaredRoot(
    step.successorRoot,
    successor.root,
    `${path}/successorRoot`,
    "stale-successor-root",
  );

  validateV4ReceiptEnvelope(step.receipt);
  if (
    step.receipt.eventRoot !== eventRoot ||
    step.receipt.priorStateRoot !== priorStateRoot ||
    step.receipt.nextStateRoot !== successorRoot
  )
    fail(
      "stale-receipt-root",
      `${path}/receipt`,
      "receipt roots must bind the event and exact state transition",
    );
  const decision = validateDecision(
    step.decision,
    step.receipt,
    `${path}/decision`,
  );
  const effects = validateOrderedEntries(step.effects, `${path}/effects`);
  if (decision.fault !== null && effects.length > 0)
    fail(
      "invalid-trace-effects",
      `${path}/effects`,
      "rejected decisions must not declare effects",
    );
  const observations = validateOrderedEntries(
    step.observations,
    `${path}/observations`,
  );
  const receiptCanonicalUtf8 = v4CanonicalBytes(step.receipt).toString("utf8");
  const receiptRoot = declaredRoot(
    step.receiptRoot,
    v4ContentRoot("transition-receipt", step.receipt),
    `${path}/receiptRoot`,
    "stale-receipt-root",
  );

  return {
    projection: {
      sequence: step.sequence,
      id: step.id,
      operation: step.operation,
      decision,
      eventRoot,
      successorCanonicalUtf8: successor.canonicalUtf8,
      successorRoot,
      generation: successor.generation,
      fencingCounter: successor.fencingCounter,
      effects: effects.map((effect) => ({
        sequence: effect.sequence,
        type: effect.type,
        canonicalUtf8: v4CanonicalBytes(effect.payload).toString("utf8"),
      })),
      observations: observations.map((observation) => ({
        sequence: observation.sequence,
        type: observation.type,
        canonicalUtf8: v4CanonicalBytes(observation.payload).toString("utf8"),
        root: v4ContentRoot("observation", observation.payload),
      })),
      receiptCanonicalUtf8,
      receiptRoot,
    },
    successorRoot,
  };
}

export function runV4DeliveryWarrantTraceFixture(
  bytes,
  { verifyExpectedRoot = true } = {},
) {
  const fixture = readBytes(bytes);
  exactKeys(
    fixture,
    ["schemaVersion", "contract", "runner", "trace", "expectedProjectionRoot"],
    "$",
  );
  if (
    fixture.schemaVersion !== 1 ||
    fixture.contract !== V4_DELIVERY_WARRANT_TRACE_CONTRACT ||
    fixture.runner !== V4_DELIVERY_WARRANT_RUNNER_CONTRACT
  )
    fail(
      "unsupported-trace-version",
      "$/schemaVersion",
      "unsupported trace fixture contract",
    );
  exactKeys(
    fixture.trace,
    ["id", "kind", "initialState", "initialStateRoot", "steps"],
    "$/trace",
  );
  token(fixture.trace.id, "$/trace/id");
  if (!["golden", "replay"].includes(fixture.trace.kind))
    fail("invalid-trace-kind", "$/trace/kind", "unsupported trace kind");
  if (!Array.isArray(fixture.trace.steps) || fixture.trace.steps.length === 0)
    fail(
      "incomplete-trace",
      "$/trace/steps",
      "trace must contain at least one step",
    );
  const initialState = validateState(
    fixture.trace.initialState,
    "$/trace/initialState",
  );
  const initialStateRoot = declaredRoot(
    fixture.trace.initialStateRoot,
    initialState.root,
    "$/trace/initialStateRoot",
    "stale-initial-root",
  );
  let priorStateRoot = initialStateRoot;
  const steps = fixture.trace.steps.map((step, index) => {
    const result = projectStep(step, index, priorStateRoot);
    priorStateRoot = result.successorRoot;
    return result.projection;
  });
  const projection = {
    schema: V4_DELIVERY_WARRANT_PROJECTION_CONTRACT,
    traceId: fixture.trace.id,
    traceKind: fixture.trace.kind,
    steps,
  };
  const projectionRoot = v4ContentRoot("semantic-diff", projection);
  validateV4Root(fixture.expectedProjectionRoot, "$/expectedProjectionRoot");
  if (verifyExpectedRoot && fixture.expectedProjectionRoot !== projectionRoot)
    fail(
      "stale-projection-root",
      "$/expectedProjectionRoot",
      "expected projection root does not match the semantic projection",
    );
  return { projection, projectionRoot };
}
