import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_PROVIDER_OPERATION_IDENTITY_CONTRACT =
  "buildchain-v4-provider-operation-identity/v1";
export const V4_PROVIDER_OPERATION_INTENT_CONTRACT =
  "buildchain-v4-provider-operation-intent/v1";
export const V4_PROVIDER_OPERATION_ATTEMPT_CONTRACT =
  "buildchain-v4-provider-operation-attempt/v1";
export const V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT =
  "buildchain-v4-provider-operation-observation/v1";
export const V4_PROVIDER_OPERATION_CONFIRMATION_CONTRACT =
  "buildchain-v4-provider-operation-confirmation/v1";
export const V4_PROVIDER_OPERATION_RECONCILIATION_CONTRACT =
  "buildchain-v4-provider-operation-reconciliation/v1";
export const V4_PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT =
  "buildchain-v4-provider-operation-journal-state/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const ENTRY = Object.freeze({
  intent: {
    schema: V4_PROVIDER_OPERATION_INTENT_CONTRACT,
    domain: "provider-operation-intent",
    keys: [
      "kind",
      "schema",
      "sequence",
      "priorEntryRoot",
      "operation",
      "operationRoot",
      "declaredAt",
      "inputRoot",
      "entryRoot",
    ],
  },
  attempt: {
    schema: V4_PROVIDER_OPERATION_ATTEMPT_CONTRACT,
    domain: "provider-operation-attempt",
    keys: [
      "kind",
      "schema",
      "sequence",
      "priorEntryRoot",
      "operationRoot",
      "attemptOrdinal",
      "attemptedAt",
      "effectRoot",
      "entryRoot",
    ],
  },
  observation: {
    schema: V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT,
    domain: "provider-operation-observation",
    keys: [
      "kind",
      "schema",
      "sequence",
      "priorEntryRoot",
      "operationRoot",
      "attemptRoot",
      "observedAt",
      "status",
      "evidenceRoots",
      "entryRoot",
    ],
  },
  confirmation: {
    schema: V4_PROVIDER_OPERATION_CONFIRMATION_CONTRACT,
    domain: "provider-operation-confirmation",
    keys: [
      "kind",
      "schema",
      "sequence",
      "priorEntryRoot",
      "operationRoot",
      "observationRoot",
      "authorityRoot",
      "confirmedAt",
      "outcome",
      "entryRoot",
    ],
  },
  reconciliation: {
    schema: V4_PROVIDER_OPERATION_RECONCILIATION_CONTRACT,
    domain: "provider-operation-reconciliation",
    keys: [
      "kind",
      "schema",
      "sequence",
      "priorEntryRoot",
      "operationRoot",
      "observationRoot",
      "authorityRoot",
      "reconciledAt",
      "disposition",
      "entryRoot",
    ],
  },
});

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault(
      "invalid-provider-operation-shape",
      path,
      `${path} must be an object`,
    );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "invalid-provider-operation-shape",
      path,
      `${path} keys are not canonical`,
    );
}

function validateToken(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-provider-operation-token",
      path,
      `${path} must be an ASCII token`,
    );
}

function validateCounter(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    fault(
      "invalid-provider-operation-counter",
      path,
      `${path} must be a safe integer greater than or equal to ${minimum}`,
    );
}

function validateRootList(value, path) {
  if (!Array.isArray(value) || value.length === 0)
    fault(
      "invalid-provider-operation-evidence",
      path,
      `${path} must contain at least one rooted observation`,
    );
  let prior = null;
  for (const [index, root] of value.entries()) {
    validateV4Root(root, `${path}/${index}`);
    if (prior !== null && root <= prior)
      fault(
        "invalid-provider-operation-evidence",
        `${path}/${index}`,
        `${path} must be unique and byte-sorted`,
      );
    prior = root;
  }
}

export function validateV4ProviderOperationIdentity(value) {
  exactKeys(
    value,
    [
      "schema",
      "transactionRoot",
      "capabilityId",
      "subjectRoot",
      "targetRoot",
      "authorityRoot",
      "policyRoot",
    ],
    "$/operation",
  );
  if (value.schema !== V4_PROVIDER_OPERATION_IDENTITY_CONTRACT)
    fault(
      "unsupported-provider-operation-version",
      "$/operation/schema",
      "unsupported provider operation identity schema",
    );
  if (
    typeof value.capabilityId !== "string" ||
    !CAPABILITY.test(value.capabilityId)
  )
    fault(
      "invalid-provider-operation-token",
      "$/operation/capabilityId",
      "capabilityId must be an ASCII dotted token",
    );
  for (const name of [
    "transactionRoot",
    "subjectRoot",
    "targetRoot",
    "authorityRoot",
    "policyRoot",
  ])
    validateV4Root(value[name], `$/operation/${name}`);
  return value;
}

export function v4ProviderOperationRoot(identity) {
  validateV4ProviderOperationIdentity(identity);
  return v4ContentRoot("provider-operation-identity", identity);
}

function entryPayload(entry) {
  const { entryRoot: _entryRoot, ...payload } = entry;
  return payload;
}

export function v4ProviderOperationEntryRoot(entry) {
  const descriptor = ENTRY[entry?.kind];
  if (!descriptor)
    fault(
      "invalid-provider-operation-shape",
      "$/kind",
      "provider operation entry kind is unsupported",
    );
  return v4ContentRoot(descriptor.domain, entryPayload(entry));
}

export function validateV4ProviderOperationEntry(entry) {
  const descriptor = ENTRY[entry?.kind];
  if (!descriptor)
    fault(
      "invalid-provider-operation-shape",
      "$/kind",
      "provider operation entry kind is unsupported",
    );
  exactKeys(entry, descriptor.keys, "$");
  if (entry.schema !== descriptor.schema)
    fault(
      "unsupported-provider-operation-version",
      "$/schema",
      "provider operation entry schema does not match its kind",
    );
  validateCounter(entry.sequence, "$/sequence");
  if (entry.priorEntryRoot !== null)
    validateV4Root(entry.priorEntryRoot, "$/priorEntryRoot");
  validateV4Root(entry.operationRoot, "$/operationRoot");
  validateV4Root(entry.entryRoot, "$/entryRoot");
  if (entry.kind === "intent") {
    validateV4ProviderOperationIdentity(entry.operation);
    validateV4Clock(entry.declaredAt, "$/declaredAt");
    validateV4Root(entry.inputRoot, "$/inputRoot");
    if (entry.operationRoot !== v4ProviderOperationRoot(entry.operation))
      fault(
        "provider-operation-root-mismatch",
        "$/operationRoot",
        "operationRoot does not bind the logical provider operation",
      );
  } else if (entry.kind === "attempt") {
    validateCounter(entry.attemptOrdinal, "$/attemptOrdinal", 1);
    validateV4Clock(entry.attemptedAt, "$/attemptedAt");
    validateV4Root(entry.effectRoot, "$/effectRoot");
  } else if (entry.kind === "observation") {
    validateV4Root(entry.attemptRoot, "$/attemptRoot");
    validateV4Clock(entry.observedAt, "$/observedAt");
    if (!["succeeded", "failed", "unknown"].includes(entry.status))
      fault(
        "invalid-provider-operation-observation",
        "$/status",
        "provider operation observation status is unsupported",
      );
    validateRootList(entry.evidenceRoots, "$/evidenceRoots");
  } else if (entry.kind === "confirmation") {
    validateV4Root(entry.observationRoot, "$/observationRoot");
    validateV4Root(entry.authorityRoot, "$/authorityRoot");
    validateV4Clock(entry.confirmedAt, "$/confirmedAt");
    if (!["confirmed", "rejected"].includes(entry.outcome))
      fault(
        "invalid-provider-operation-confirmation",
        "$/outcome",
        "provider operation confirmation outcome is unsupported",
      );
  } else {
    validateV4Root(entry.observationRoot, "$/observationRoot");
    validateV4Root(entry.authorityRoot, "$/authorityRoot");
    validateV4Clock(entry.reconciledAt, "$/reconciledAt");
    if (!["retry", "confirm", "terminal"].includes(entry.disposition))
      fault(
        "invalid-provider-operation-reconciliation",
        "$/disposition",
        "provider operation reconciliation disposition is unsupported",
      );
  }
  if (entry.entryRoot !== v4ProviderOperationEntryRoot(entry))
    fault(
      "provider-operation-entry-root-mismatch",
      "$/entryRoot",
      "entryRoot does not bind the canonical provider operation entry",
    );
  return entry;
}

function transitionFault(entry, phase) {
  fault(
    "impossible-provider-operation-transition",
    `$/entries/${entry.sequence}/kind`,
    `${entry.kind} cannot follow provider operation phase ${phase}`,
  );
}

function assertJournalCoordinates(context, entry, index) {
  validateV4ProviderOperationEntry(entry);
  if (entry.sequence !== index)
    fault(
      "provider-operation-sequence-conflict",
      `$/entries/${index}/sequence`,
      "provider operation sequence must be contiguous and zero-based",
    );
  const expectedPrior = context?.state.lastEntryRoot ?? null;
  if (entry.priorEntryRoot !== expectedPrior)
    fault(
      "provider-operation-causal-link-mismatch",
      `$/entries/${index}/priorEntryRoot`,
      "priorEntryRoot does not bind the append-only predecessor",
    );
}

function initializeJournal(entry) {
  if (entry.kind !== "intent") transitionFault(entry, "empty");
  return {
    authorityRoot: entry.operation.authorityRoot,
    lastObservationStatus: null,
    state: {
      schema: V4_PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT,
      operationRoot: entry.operationRoot,
      phase: "intended",
      entryCount: 1,
      attemptCount: 0,
      lastEntryRoot: entry.entryRoot,
      activeAttemptRoot: null,
      lastObservationRoot: null,
      confirmationRoot: null,
      reconciliationRoot: null,
    },
  };
}

function applyAttempt(context, entry, index) {
  const { state } = context;
  if (!["intended", "retryable"].includes(state.phase))
    transitionFault(entry, state.phase);
  if (entry.attemptOrdinal !== state.attemptCount + 1)
    fault(
      "provider-operation-attempt-conflict",
      `$/entries/${index}/attemptOrdinal`,
      "attemptOrdinal must append exactly one logical retry attempt",
    );
  state.phase = "attempting";
  state.attemptCount += 1;
  state.activeAttemptRoot = entry.entryRoot;
  state.lastObservationRoot = null;
  context.lastObservationStatus = null;
}

function applyObservation(context, entry, index) {
  const { state } = context;
  if (state.phase !== "attempting") transitionFault(entry, state.phase);
  if (entry.attemptRoot !== state.activeAttemptRoot)
    fault(
      "provider-operation-causal-link-mismatch",
      `$/entries/${index}/attemptRoot`,
      "observation must bind the active rooted attempt",
    );
  state.phase = "observed";
  state.lastObservationRoot = entry.entryRoot;
  context.lastObservationStatus = entry.status;
}

function applyReconciliation(context, entry, index) {
  const { state } = context;
  if (entry.authorityRoot !== context.authorityRoot)
    fault(
      "provider-operation-authority-escalation",
      `$/entries/${index}/authorityRoot`,
      "reconciliation cannot change the declared authority root",
    );
  if (state.phase !== "observed") transitionFault(entry, state.phase);
  if (entry.observationRoot !== state.lastObservationRoot)
    fault(
      "provider-operation-causal-link-mismatch",
      `$/entries/${index}/observationRoot`,
      "reconciliation must bind the latest rooted observation",
    );
  if (
    (entry.disposition === "retry" &&
      context.lastObservationStatus === "succeeded") ||
    (entry.disposition === "confirm" &&
      context.lastObservationStatus !== "succeeded")
  )
    fault(
      "invalid-provider-operation-reconciliation",
      `$/entries/${index}/disposition`,
      "reconciliation disposition conflicts with the rooted observation",
    );
  state.phase =
    entry.disposition === "retry"
      ? "retryable"
      : entry.disposition === "confirm"
        ? "confirmable"
        : "terminal";
  state.reconciliationRoot = entry.entryRoot;
}

function applyConfirmation(context, entry, index) {
  const { state } = context;
  if (entry.authorityRoot !== context.authorityRoot)
    fault(
      "provider-operation-authority-escalation",
      `$/entries/${index}/authorityRoot`,
      "confirmation cannot change the declared authority root",
    );
  if (["confirmed", "rejected"].includes(state.phase))
    fault(
      "conflicting-provider-operation-confirmation",
      `$/entries/${index}`,
      "a terminal provider operation cannot receive another confirmation",
    );
  if (
    !["observed", "confirmable"].includes(state.phase) ||
    context.lastObservationStatus !== "succeeded" ||
    entry.observationRoot !== state.lastObservationRoot
  )
    fault(
      "confirmation-without-rooted-observation",
      `$/entries/${index}/observationRoot`,
      "confirmation requires the latest successful rooted observation",
    );
  state.phase = entry.outcome;
  state.confirmationRoot = entry.entryRoot;
}

function applyJournalEntry(context, entry, index) {
  if (entry.operationRoot !== context.state.operationRoot)
    fault(
      "provider-operation-identity-drift",
      `$/entries/${index}/operationRoot`,
      "retry records must preserve logical operation identity",
    );
  if (entry.kind === "intent") transitionFault(entry, context.state.phase);
  if (entry.kind === "attempt") applyAttempt(context, entry, index);
  else if (entry.kind === "observation")
    applyObservation(context, entry, index);
  else if (entry.kind === "reconciliation")
    applyReconciliation(context, entry, index);
  else applyConfirmation(context, entry, index);
  context.state.entryCount += 1;
  context.state.lastEntryRoot = entry.entryRoot;
}

export function foldV4ProviderOperationJournal(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    fault(
      "invalid-provider-operation-journal",
      "$/entries",
      "provider operation journal must contain an intent",
    );
  let context = null;
  for (const [index, entry] of entries.entries()) {
    assertJournalCoordinates(context, entry, index);
    if (index === 0) context = initializeJournal(entry);
    else applyJournalEntry(context, entry, index);
  }
  return context.state;
}

export function v4ProviderOperationJournalRoot(entries) {
  foldV4ProviderOperationJournal(entries);
  return v4ContentRoot("provider-operation-journal", entries);
}

export function v4ProviderOperationJournalStateRoot(entries) {
  return v4ContentRoot(
    "provider-operation-journal-state",
    foldV4ProviderOperationJournal(entries),
  );
}

export function projectV4ProviderOperationFixtures(fixtures) {
  exactKeys(
    fixtures,
    ["schemaVersion", "contract", "validCases", "invalidCases"],
    "$",
  );
  if (
    fixtures.schemaVersion !== 1 ||
    fixtures.contract !==
      "buildchain-v4-provider-operation-journal-fixtures/v1" ||
    !Array.isArray(fixtures.validCases) ||
    !Array.isArray(fixtures.invalidCases)
  )
    fault(
      "unsupported-provider-operation-version",
      "$/schemaVersion",
      "unsupported provider operation fixture contract",
    );
  const validCases = fixtures.validCases.map(({ id, entries }) => {
    const state = foldV4ProviderOperationJournal(entries);
    return {
      id,
      operationRoot: state.operationRoot,
      entryRoots: entries.map((entry) => entry.entryRoot),
      journalRoot: v4ProviderOperationJournalRoot(entries),
      state,
      stateRoot: v4ProviderOperationJournalStateRoot(entries),
    };
  });
  const invalidCases = fixtures.invalidCases.map(({ id, entries }) => {
    try {
      foldV4ProviderOperationJournal(entries);
    } catch (error) {
      if (error instanceof V4ContractFault) return { id, fault: error.code };
      throw error;
    }
    fault(
      "invalid-provider-operation-fixture",
      "$/invalidCases",
      `fixture ${id} unexpectedly passed`,
    );
  });
  return { validCases, invalidCases };
}
