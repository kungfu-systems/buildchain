import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_PROVIDER_OPERATION_ATTEMPT_CONTRACT,
  V4_PROVIDER_OPERATION_CONFIRMATION_CONTRACT,
  V4_PROVIDER_OPERATION_INTENT_CONTRACT,
  V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT,
  V4_PROVIDER_OPERATION_RECONCILIATION_CONTRACT,
  foldV4ProviderOperationJournal,
  v4ProviderOperationEntryRoot,
  v4ProviderOperationJournalRoot,
  v4ProviderOperationJournalStateRoot,
  v4ProviderOperationRoot,
  validateV4ProviderOperationIdentity,
} from "./v4-provider-operation-journal.js";

export const V4_RELEASE_ACTIVATION_REQUEST_CONTRACT =
  "buildchain-v4-release-activation-request/v1";
export const V4_RELEASE_ACTIVATION_PLAN_CONTRACT =
  "buildchain-v4-release-activation-plan/v1";
export const V4_RELEASE_ACTIVATION_STATE_CONTRACT =
  "buildchain-v4-release-activation-state/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault(
      "invalid-release-activation-shape",
      path,
      `${path} must be an object`,
    );
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-release-activation-shape",
      path,
      `${path} keys do not match the closed activation contract`,
    );
}

function token(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-release-activation-token",
      path,
      `${path} must be an ASCII token`,
    );
}

function normalizeTokens(values, path) {
  if (!Array.isArray(values))
    fault("invalid-release-activation-shape", path, `${path} must be an array`);
  for (const [index, value] of values.entries())
    token(value, `${path}/${index}`);
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length)
    fault(
      "duplicate-release-activation-dependency",
      path,
      `${path} must not contain duplicate values`,
    );
  return sorted;
}

function normalizeRoots(values, path) {
  if (!Array.isArray(values) || values.length === 0)
    fault(
      "unrooted-release-activation-observation",
      path,
      `${path} must contain rooted provider-neutral evidence`,
    );
  for (const [index, value] of values.entries())
    validateV4Root(value, `${path}/${index}`);
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length)
    fault(
      "duplicate-release-activation-observation-root",
      path,
      `${path} must not contain duplicate roots`,
    );
  return sorted;
}

function validateCoordinates(request) {
  validateV4Root(request.transactionRoot, "$/transactionRoot");
  if (request.qualificationRoot === null)
    fault(
      "missing-release-activation-qualification",
      "$/qualificationRoot",
      "release activation requires an explicit qualification root",
    );
  validateV4Root(request.qualificationRoot, "$/qualificationRoot");
  validateV4Root(request.authorityRoot, "$/authorityRoot");
  validateV4Root(request.policyRoot, "$/policyRoot");
  validateV4Clock(request.declaredAt, "$/declaredAt");
}

function normalizeSteps(request) {
  if (!Array.isArray(request.steps) || request.steps.length === 0)
    fault(
      "invalid-release-activation-plan",
      "$/steps",
      "release activation requires at least one step",
    );
  const normalized = request.steps.map((step, index) => {
    const path = `$/steps/${index}`;
    exactKeys(
      step,
      ["id", "dependencies", "operation", "compensationBoundaryRoot"],
      path,
    );
    token(step.id, `${path}/id`);
    validateV4ProviderOperationIdentity(step.operation);
    validateV4Root(
      step.compensationBoundaryRoot,
      `${path}/compensationBoundaryRoot`,
    );
    if (
      step.operation.transactionRoot !== request.transactionRoot ||
      step.operation.authorityRoot !== request.authorityRoot ||
      step.operation.policyRoot !== request.policyRoot
    )
      fault(
        "release-activation-authority-mismatch",
        `${path}/operation`,
        "step operation coordinates must match the qualified activation request",
      );
    const operationRoot = v4ProviderOperationRoot(step.operation);
    const payload = {
      id: step.id,
      dependencies: normalizeTokens(step.dependencies, `${path}/dependencies`),
      operation: structuredClone(step.operation),
      operationRoot,
      compensationBoundaryRoot: step.compensationBoundaryRoot,
    };
    return {
      ...payload,
      stepRoot: v4ContentRoot("release-activation-step", payload),
    };
  });
  normalized.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length)
    fault(
      "duplicate-release-activation-step",
      "$/steps",
      "release activation step ids must be unique",
    );
  if (
    new Set(normalized.map(({ operationRoot }) => operationRoot)).size !==
    normalized.length
  )
    fault(
      "conflicting-release-activation-operation",
      "$/steps",
      "one logical provider operation cannot be owned by multiple activation steps",
    );
  const byId = new Map(normalized.map((step) => [step.id, step]));
  for (const step of normalized)
    for (const dependency of step.dependencies)
      if (!byId.has(dependency) || dependency === step.id)
        fault(
          "invalid-release-activation-dependency",
          `$/steps/${step.id}/dependencies`,
          "dependencies must name another declared activation step",
        );
  const visiting = new Set();
  const visited = new Set();
  const visit = (step) => {
    if (visiting.has(step.id))
      fault(
        "release-activation-dependency-cycle",
        `$/steps/${step.id}/dependencies`,
        "release activation dependencies must be acyclic",
      );
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const dependency of step.dependencies) visit(byId.get(dependency));
    visiting.delete(step.id);
    visited.add(step.id);
  };
  for (const step of normalized) visit(step);
  return normalized;
}

function normalizeEvent(event, index, steps) {
  const path = `$/events/${index}`;
  const common = ["kind", "stepId", "ordinal"];
  const specific = {
    attempt: ["attemptedAt", "effectRoot"],
    observation: ["observedAt", "status", "evidenceRoots"],
    reconciliation: ["reconciledAt", "disposition", "authorityRoot"],
    confirmation: ["confirmedAt", "outcome", "authorityRoot"],
  };
  if (!specific[event?.kind])
    fault(
      "invalid-release-activation-event",
      `${path}/kind`,
      "release activation event kind is unsupported",
    );
  exactKeys(event, [...common, ...specific[event.kind]], path);
  token(event.stepId, `${path}/stepId`);
  if (!steps.has(event.stepId))
    fault(
      "invalid-release-activation-event",
      `${path}/stepId`,
      "event must name a declared activation step",
    );
  if (!Number.isSafeInteger(event.ordinal) || event.ordinal < 1)
    fault(
      "invalid-release-activation-ordinal",
      `${path}/ordinal`,
      "event ordinal must be a positive safe integer",
    );
  const normalized = structuredClone(event);
  if (event.kind === "attempt") {
    validateV4Clock(event.attemptedAt, `${path}/attemptedAt`);
    validateV4Root(event.effectRoot, `${path}/effectRoot`);
  } else if (event.kind === "observation") {
    validateV4Clock(event.observedAt, `${path}/observedAt`);
    if (!["succeeded", "failed", "unknown"].includes(event.status))
      fault(
        "invalid-release-activation-observation",
        `${path}/status`,
        "observation status is unsupported",
      );
    normalized.evidenceRoots = normalizeRoots(
      event.evidenceRoots,
      `${path}/evidenceRoots`,
    );
  } else if (event.kind === "reconciliation") {
    validateV4Clock(event.reconciledAt, `${path}/reconciledAt`);
    validateV4Root(event.authorityRoot, `${path}/authorityRoot`);
    if (!["retry", "confirm", "terminal"].includes(event.disposition))
      fault(
        "invalid-release-activation-reconciliation",
        `${path}/disposition`,
        "reconciliation disposition is unsupported",
      );
  } else {
    validateV4Clock(event.confirmedAt, `${path}/confirmedAt`);
    validateV4Root(event.authorityRoot, `${path}/authorityRoot`);
    if (!["confirmed", "rejected"].includes(event.outcome))
      fault(
        "invalid-release-activation-confirmation",
        `${path}/outcome`,
        "confirmation outcome is unsupported",
      );
  }
  if (
    "authorityRoot" in normalized &&
    normalized.authorityRoot !== steps.get(event.stepId).operation.authorityRoot
  )
    fault(
      "release-activation-authority-mismatch",
      `${path}/authorityRoot`,
      "journal authority cannot differ from the planned operation authority",
    );
  return normalized;
}

function normalizeEvents(request, steps) {
  if (!Array.isArray(request.events))
    fault(
      "invalid-release-activation-shape",
      "$/events",
      "events must be an array",
    );
  const unique = new Map();
  for (const [index, event] of request.events.entries()) {
    const normalized = normalizeEvent(event, index, steps);
    const key = `${normalized.stepId}:${normalized.ordinal}`;
    const retained = unique.get(key);
    if (retained && JSON.stringify(retained) !== JSON.stringify(normalized))
      fault(
        "conflicting-release-activation-event",
        `$/events/${index}`,
        "one step ordinal cannot carry conflicting journal facts",
      );
    unique.set(key, retained ?? normalized);
  }
  const events = [...unique.values()].sort((left, right) => {
    if (left.stepId !== right.stepId)
      return left.stepId < right.stepId ? -1 : 1;
    return left.ordinal - right.ordinal;
  });
  const expected = new Map();
  for (const event of events) {
    const ordinal = (expected.get(event.stepId) ?? 0) + 1;
    if (event.ordinal !== ordinal)
      fault(
        "release-activation-event-gap",
        `$/events/${event.stepId}/${event.ordinal}`,
        "deduplicated event ordinals must be contiguous per step",
      );
    expected.set(event.stepId, ordinal);
  }
  return events;
}

function normalizeRequest(request) {
  exactKeys(
    request,
    [
      "schema",
      "declaredAt",
      "transactionRoot",
      "qualificationRoot",
      "authorityRoot",
      "policyRoot",
      "steps",
      "events",
    ],
    "$",
  );
  if (request.schema !== V4_RELEASE_ACTIVATION_REQUEST_CONTRACT)
    fault(
      "unsupported-release-activation-version",
      "$/schema",
      "unsupported release activation request schema",
    );
  validateCoordinates(request);
  const steps = normalizeSteps(request);
  const byId = new Map(steps.map((step) => [step.id, step]));
  return { steps, events: normalizeEvents(request, byId) };
}

export function planV4ReleaseActivation(request) {
  const { steps } = normalizeRequest(request);
  const payload = {
    schema: V4_RELEASE_ACTIVATION_PLAN_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v3",
    declaredAt: request.declaredAt,
    transactionRoot: request.transactionRoot,
    qualificationRoot: request.qualificationRoot,
    authorityRoot: request.authorityRoot,
    policyRoot: request.policyRoot,
    steps,
  };
  return {
    ...payload,
    planRoot: v4ContentRoot("release-activation-plan", payload),
  };
}

function rootedEntry(entry) {
  return { ...entry, entryRoot: v4ProviderOperationEntryRoot(entry) };
}

function materializeJournal(request, step, events) {
  const entries = [];
  const append = (entry) => {
    entries.push(rootedEntry(entry));
    return entries.at(-1);
  };
  append({
    kind: "intent",
    schema: V4_PROVIDER_OPERATION_INTENT_CONTRACT,
    sequence: 0,
    priorEntryRoot: null,
    operation: structuredClone(step.operation),
    operationRoot: step.operationRoot,
    declaredAt: request.declaredAt,
    inputRoot: request.qualificationRoot,
  });
  let attemptOrdinal = 0;
  let attemptRoot = null;
  let observationRoot = null;
  for (const event of events) {
    const common = {
      sequence: entries.length,
      priorEntryRoot: entries.at(-1).entryRoot,
      operationRoot: step.operationRoot,
    };
    if (event.kind === "attempt") {
      attemptOrdinal += 1;
      const entry = append({
        kind: "attempt",
        schema: V4_PROVIDER_OPERATION_ATTEMPT_CONTRACT,
        ...common,
        attemptOrdinal,
        attemptedAt: event.attemptedAt,
        effectRoot: event.effectRoot,
      });
      attemptRoot = entry.entryRoot;
      observationRoot = null;
    } else if (event.kind === "observation") {
      const entry = append({
        kind: "observation",
        schema: V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT,
        ...common,
        attemptRoot: attemptRoot ?? request.qualificationRoot,
        observedAt: event.observedAt,
        status: event.status,
        evidenceRoots: event.evidenceRoots,
      });
      observationRoot = entry.entryRoot;
    } else if (event.kind === "reconciliation") {
      append({
        kind: "reconciliation",
        schema: V4_PROVIDER_OPERATION_RECONCILIATION_CONTRACT,
        ...common,
        observationRoot: observationRoot ?? request.qualificationRoot,
        authorityRoot: event.authorityRoot,
        reconciledAt: event.reconciledAt,
        disposition: event.disposition,
      });
    } else {
      append({
        kind: "confirmation",
        schema: V4_PROVIDER_OPERATION_CONFIRMATION_CONTRACT,
        ...common,
        observationRoot: observationRoot ?? request.qualificationRoot,
        authorityRoot: event.authorityRoot,
        confirmedAt: event.confirmedAt,
        outcome: event.outcome,
      });
    }
  }
  return entries;
}

export function foldV4ReleaseActivation(request) {
  const normalized = normalizeRequest(request);
  const plan = planV4ReleaseActivation(request);
  const events = new Map(normalized.steps.map(({ id }) => [id, []]));
  for (const event of normalized.events) events.get(event.stepId).push(event);
  const confirmed = new Set();
  const failedSteps = [];
  const readbackSteps = [];
  const stepStates = normalized.steps.map((step) => {
    const retained = events.get(step.id);
    if (retained.length === 0)
      return {
        stepId: step.id,
        operationRoot: step.operationRoot,
        phase: "planned",
        journalRoot: null,
        journalStateRoot: null,
        entryCount: 0,
        attemptCount: 0,
        confirmationRoot: null,
      };
    const entries = materializeJournal(request, step, retained);
    const state = foldV4ProviderOperationJournal(entries);
    if (state.phase === "confirmed") confirmed.add(step.id);
    if (["rejected", "terminal"].includes(state.phase))
      failedSteps.push(step.id);
    if (["attempting", "observed", "confirmable"].includes(state.phase))
      readbackSteps.push(step.id);
    return {
      stepId: step.id,
      operationRoot: step.operationRoot,
      phase: state.phase,
      journalRoot: v4ProviderOperationJournalRoot(entries),
      journalStateRoot: v4ProviderOperationJournalStateRoot(entries),
      entryCount: state.entryCount,
      attemptCount: state.attemptCount,
      confirmationRoot: state.confirmationRoot,
    };
  });
  const eligibleSteps =
    failedSteps.length === 0
      ? normalized.steps
          .filter((step, index) => {
            const phase = stepStates[index].phase;
            return (
              ["planned", "intended", "retryable"].includes(phase) &&
              step.dependencies.every((dependency) => confirmed.has(dependency))
            );
          })
          .map(({ id }) => id)
      : [];
  const confirmedSteps = [...confirmed].sort();
  const phase =
    failedSteps.length > 0
      ? "blocked"
      : confirmedSteps.length === normalized.steps.length
        ? "complete"
        : "active";
  const payload = {
    schema: V4_RELEASE_ACTIVATION_STATE_CONTRACT,
    mode: "shadow-only",
    productionAuthority: "v3",
    planRoot: plan.planRoot,
    phase,
    stepStates,
    confirmedSteps,
    failedSteps,
    readbackSteps,
    eligibleSteps,
  };
  return {
    ...payload,
    stateRoot: v4ContentRoot("release-activation-state", payload),
  };
}

export function projectV4ReleaseActivation(request) {
  return {
    plan: planV4ReleaseActivation(request),
    state: foldV4ReleaseActivation(request),
  };
}
