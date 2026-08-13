import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_TAIL_DECLARATION_CONTRACT =
  "kungfu-buildchain-release-tail-capabilities";
export const RELEASE_TAIL_TRANSACTION_POLICY = "buildchain.release-tail/v1";
export const RELEASE_TAIL_TRANSACTION_SCHEMA =
  "kungfu.buildchain.release-tail.transaction/v1";
export const RELEASE_TAIL_EFFECT_SCHEMA =
  "kungfu.buildchain.release-tail.effect/v1";
export const RELEASE_TAIL_OBSERVATION_SCHEMA =
  "kungfu.buildchain.release-tail.observation/v1";
export const RELEASE_TAIL_RECEIPT_SCHEMA =
  "kungfu.buildchain.release-tail.receipt/v1";

export const RELEASE_TAIL_STATES = Object.freeze([
  "preparing",
  "prepared",
  "publishing",
  "committing",
  "activating",
  "reading-back",
  "settling",
  "complete",
  "blocked",
  "repair-required",
  "terminal-failure",
]);

export const RELEASE_TAIL_CAPABILITY_REGISTRY = Object.freeze([
  Object.freeze({
    id: "artifact.publish",
    executor: "provider-adapter",
    adapter: "github-release-assets",
    effectKind: "artifact-publication",
    observationKind: "artifact-publication-readback",
    receiptKind: "artifact-publication",
    transactionState: "publishing",
  }),
  Object.freeze({
    id: "signed-channel.commit",
    executor: "provider-adapter",
    adapter: "signed-static-channel",
    effectKind: "signed-channel-commit",
    observationKind: "signed-channel-readback",
    receiptKind: "publication-commit",
    transactionState: "committing",
  }),
  Object.freeze({
    id: "release.activate",
    executor: "provider-adapter",
    adapter: "site-release-activation",
    effectKind: "release-activation",
    observationKind: "production-readback",
    receiptKind: "activation-receipt-set",
    transactionState: "activating",
  }),
  Object.freeze({
    id: "released-evidence.synthesize",
    executor: "buildchain-core",
    adapter: "activation-receipt-projector",
    effectKind: "released-evidence-projection",
    observationKind: "released-evidence-validation",
    receiptKind: "released-evidence",
    transactionState: "settling",
  }),
]);

const CAPABILITY_BY_ID = new Map(
  RELEASE_TAIL_CAPABILITY_REGISTRY.map((entry) => [entry.id, entry]),
);
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const FORBIDDEN_KEYS = new Set([
  "cmd",
  "command",
  "eval",
  "executable",
  "javascript",
  "run",
  "script",
  "shell",
]);
const TOP_LEVEL_FIELDS = [
  "contract",
  "schemaVersion",
  "transactionPolicy",
  "subject",
  "capabilities",
];
const SUBJECT_FIELDS = ["repository", "sourceSha", "version", "tag", "channel"];
const CAPABILITY_FIELDS = [
  "id",
  "executor",
  "adapter",
  "artifactRoles",
  "destination",
  "channelPolicy",
  "activationPolicy",
  "readbackPredicates",
  "effect",
  "observation",
  "receipt",
  "operationIdentity",
  "idempotency",
  "retry",
  "evidenceRequirements",
];
const EFFECT_PLAN_FIELDS = [
  "schema",
  "transactionPolicy",
  "transactionRoot",
  "declarationRoot",
  "subject",
  "operationOrder",
  "effects",
  "planRoot",
];
const EFFECT_FIELDS = [
  "schema",
  "kind",
  "transactionRoot",
  "operationId",
  "capabilityId",
  "executor",
  "adapter",
  "subjectRoot",
  "targetRoot",
  "attemptKey",
  "subject",
  "artifactRoles",
  "destination",
  "channelPolicy",
  "activationPolicy",
  "readbackPredicates",
  "idempotency",
  "retry",
  "evidenceRequirements",
  "effectRoot",
];
const TERMINAL_STATES = new Set([
  "complete",
  "blocked",
  "repair-required",
  "terminal-failure",
]);

export function releaseTailStableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(releaseTailStableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${releaseTailStableJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function releaseTailRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(releaseTailStableJson(value))
    .digest("hex")}`;
}

function fail(message) {
  throw new Error(`invalid release-tail declaration: ${message}`);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactFields(value, fields, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.join("\n") !== expected.join("\n")) {
    fail(`${label} fields must be exactly: ${fields.join(", ")}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function exactRoot(value, label) {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!ROOT.test(normalized)) fail(`${label} must be a sha256 content root`);
  return normalized;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) {
    fail(`${label} must be one of ${choices.join(", ")}`);
  }
  return value;
}

function rejectExecutableKeys(value, pointer = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectExecutableKeys(entry, `${pointer}/${index}`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail(`executable key '${key}' is forbidden at ${pointer}`);
    }
    rejectExecutableKeys(entry, `${pointer}/${key}`);
  }
}

function normalizeMessage(value, expectedSchema, expectedKind, label) {
  exactFields(value, ["kind", "schema"], label);
  if (value.schema !== expectedSchema) fail(`${label}.schema is not supported`);
  if (value.kind !== expectedKind)
    fail(`${label}.kind must be ${expectedKind}`);
  return { kind: value.kind, schema: value.schema };
}

function normalizeCapability(value, subject) {
  exactFields(
    value,
    CAPABILITY_FIELDS,
    `capability ${value?.id || "<unknown>"}`,
  );
  const registry = CAPABILITY_BY_ID.get(value.id);
  if (!registry) fail(`unsupported capability id: ${value.id || "<empty>"}`);
  if (value.executor !== registry.executor) {
    fail(`${value.id}.executor must be ${registry.executor}`);
  }
  if (value.adapter !== registry.adapter) {
    fail(`${value.id}.adapter must be ${registry.adapter}`);
  }
  if (!Array.isArray(value.artifactRoles)) {
    fail(`${value.id}.artifactRoles must be an array`);
  }
  const artifactRoles = value.artifactRoles.map((entry, index) => {
    exactFields(entry, ["role", "root"], `${value.id}.artifactRoles[${index}]`);
    return {
      role: nonEmpty(entry.role, `${value.id}.artifactRoles[${index}].role`),
      root: exactRoot(entry.root, `${value.id}.artifactRoles[${index}].root`),
    };
  });
  if (
    new Set(artifactRoles.map((entry) => entry.role)).size !==
    artifactRoles.length
  ) {
    fail(`${value.id}.artifactRoles contains duplicate roles`);
  }

  exactFields(
    value.destination,
    ["kind", "locator"],
    `${value.id}.destination`,
  );
  const destination = {
    kind: nonEmpty(value.destination.kind, `${value.id}.destination.kind`),
    locator: nonEmpty(
      value.destination.locator,
      `${value.id}.destination.locator`,
    ),
  };

  exactFields(
    value.channelPolicy,
    ["channel", "tagPattern", "authorityMove"],
    `${value.id}.channelPolicy`,
  );
  const channel = oneOf(
    value.channelPolicy.channel,
    ["alpha", "release", "stable"],
    `${value.id}.channelPolicy.channel`,
  );
  if (channel !== subject.channel)
    fail(`${value.id} channel does not match subject`);
  const tagPattern = nonEmpty(
    value.channelPolicy.tagPattern,
    `${value.id}.channelPolicy.tagPattern`,
  );
  let tagExpression;
  try {
    tagExpression = new RegExp(tagPattern, "u");
  } catch {
    fail(`${value.id}.channelPolicy.tagPattern is not a valid expression`);
  }
  if (!tagExpression.test(subject.tag)) {
    fail(`${value.id}.channelPolicy.tagPattern does not match subject.tag`);
  }
  const channelPolicy = {
    channel,
    tagPattern,
    authorityMove: oneOf(
      value.channelPolicy.authorityMove,
      ["none", "signed-cas", "verified-ref"],
      `${value.id}.channelPolicy.authorityMove`,
    ),
  };

  exactFields(
    value.activationPolicy,
    ["mode", "environment"],
    `${value.id}.activationPolicy`,
  );
  const activationPolicy = {
    mode: oneOf(
      value.activationPolicy.mode,
      ["none", "receipt-set", "receipt-only"],
      `${value.id}.activationPolicy.mode`,
    ),
    environment: oneOf(
      value.activationPolicy.environment,
      ["none", "shadow", "production"],
      `${value.id}.activationPolicy.environment`,
    ),
  };

  if (
    !Array.isArray(value.readbackPredicates) ||
    value.readbackPredicates.length === 0
  ) {
    fail(`${value.id} must declare at least one readback predicate`);
  }
  const readbackPredicates = value.readbackPredicates.map((entry, index) => {
    exactFields(
      entry,
      ["id", "kind", "expected"],
      `${value.id}.readbackPredicates[${index}]`,
    );
    return {
      id: nonEmpty(entry.id, `${value.id}.readbackPredicates[${index}].id`),
      kind: nonEmpty(
        entry.kind,
        `${value.id}.readbackPredicates[${index}].kind`,
      ),
      expected: nonEmpty(
        entry.expected,
        `${value.id}.readbackPredicates[${index}].expected`,
      ),
    };
  });
  if (
    new Set(readbackPredicates.map((entry) => entry.id)).size !==
    readbackPredicates.length
  ) {
    fail(`${value.id}.readbackPredicates contains duplicate ids`);
  }

  exactFields(
    value.operationIdentity,
    [
      "transactionRoot",
      "capabilityId",
      "subjectRoot",
      "targetRoot",
      "attemptKey",
    ],
    `${value.id}.operationIdentity`,
  );
  if (value.operationIdentity.capabilityId !== value.id) {
    fail(
      `${value.id}.operationIdentity.capabilityId must match the capability id`,
    );
  }
  const operationIdentity = {
    transactionRoot: exactRoot(
      value.operationIdentity.transactionRoot,
      `${value.id}.operationIdentity.transactionRoot`,
    ),
    capabilityId: value.id,
    subjectRoot: exactRoot(
      value.operationIdentity.subjectRoot,
      `${value.id}.operationIdentity.subjectRoot`,
    ),
    targetRoot: exactRoot(
      value.operationIdentity.targetRoot,
      `${value.id}.operationIdentity.targetRoot`,
    ),
    attemptKey: nonEmpty(
      value.operationIdentity.attemptKey,
      `${value.id}.operationIdentity.attemptKey`,
    ),
  };

  exactFields(
    value.idempotency,
    ["scope", "duplicate"],
    `${value.id}.idempotency`,
  );
  const idempotency = {
    scope: oneOf(
      value.idempotency.scope,
      ["operation", "subject-target"],
      `${value.id}.idempotency.scope`,
    ),
    duplicate: oneOf(
      value.idempotency.duplicate,
      ["return-observed-receipt", "readback-before-retry"],
      `${value.id}.idempotency.duplicate`,
    ),
  };

  exactFields(
    value.retry,
    ["class", "localAttempts", "exhausted"],
    `${value.id}.retry`,
  );
  const localAttempts = value.retry.localAttempts;
  if (
    !Number.isSafeInteger(localAttempts) ||
    localAttempts < 0 ||
    localAttempts > 3
  ) {
    fail(`${value.id}.retry.localAttempts must be between zero and three`);
  }
  const retry = {
    class: oneOf(
      value.retry.class,
      ["never", "readback", "provider-transient"],
      `${value.id}.retry.class`,
    ),
    localAttempts,
    exhausted: oneOf(
      value.retry.exhausted,
      ["blocked", "repair-required", "terminal-failure"],
      `${value.id}.retry.exhausted`,
    ),
  };
  if (retry.class === "never" && retry.localAttempts !== 0) {
    fail(`${value.id}.retry.localAttempts must be zero for retry class never`);
  }

  if (
    !Array.isArray(value.evidenceRequirements) ||
    value.evidenceRequirements.length === 0
  ) {
    fail(`${value.id}.evidenceRequirements must not be empty`);
  }
  const evidenceRequirements = value.evidenceRequirements.map((entry, index) =>
    nonEmpty(entry, `${value.id}.evidenceRequirements[${index}]`),
  );

  return {
    id: value.id,
    executor: value.executor,
    adapter: value.adapter,
    artifactRoles,
    destination,
    channelPolicy,
    activationPolicy,
    readbackPredicates,
    effect: normalizeMessage(
      value.effect,
      RELEASE_TAIL_EFFECT_SCHEMA,
      registry.effectKind,
      `${value.id}.effect`,
    ),
    observation: normalizeMessage(
      value.observation,
      RELEASE_TAIL_OBSERVATION_SCHEMA,
      registry.observationKind,
      `${value.id}.observation`,
    ),
    receipt: normalizeMessage(
      value.receipt,
      RELEASE_TAIL_RECEIPT_SCHEMA,
      registry.receiptKind,
      `${value.id}.receipt`,
    ),
    operationIdentity,
    idempotency,
    retry,
    evidenceRequirements,
  };
}

export function parseReleaseTailDeclaration(input) {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      fail(`input is not valid JSON: ${error.message}`);
    }
  }
  value = structuredClone(plainObject(value, "declaration"));
  rejectExecutableKeys(value);
  exactFields(value, TOP_LEVEL_FIELDS, "declaration");
  if (value.contract !== RELEASE_TAIL_DECLARATION_CONTRACT) {
    fail(`contract must be ${RELEASE_TAIL_DECLARATION_CONTRACT}`);
  }
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.transactionPolicy !== RELEASE_TAIL_TRANSACTION_POLICY) {
    fail(`transactionPolicy must be ${RELEASE_TAIL_TRANSACTION_POLICY}`);
  }
  exactFields(value.subject, SUBJECT_FIELDS, "subject");
  const subject = {
    repository: nonEmpty(value.subject.repository, "subject.repository"),
    sourceSha: nonEmpty(
      value.subject.sourceSha,
      "subject.sourceSha",
    ).toLowerCase(),
    version: nonEmpty(value.subject.version, "subject.version"),
    tag: nonEmpty(value.subject.tag, "subject.tag"),
    channel: oneOf(
      value.subject.channel,
      ["alpha", "release", "stable"],
      "subject.channel",
    ),
  };
  if (!SHA.test(subject.sourceSha)) {
    fail("subject.sourceSha must be an exact 40-character Git SHA");
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    fail("capabilities must not be empty");
  }
  const capabilities = value.capabilities.map((entry) =>
    normalizeCapability(entry, subject),
  );
  if (
    new Set(capabilities.map((entry) => entry.id)).size !== capabilities.length
  ) {
    fail("capability ids must be unique");
  }
  const order = new Map(
    RELEASE_TAIL_CAPABILITY_REGISTRY.map((entry, index) => [entry.id, index]),
  );
  capabilities.sort((left, right) => order.get(left.id) - order.get(right.id));
  const transactionRoots = new Set(
    capabilities.map((entry) => entry.operationIdentity.transactionRoot),
  );
  if (transactionRoots.size !== 1) {
    fail("all operation identities must bind one transaction root");
  }
  return {
    contract: RELEASE_TAIL_DECLARATION_CONTRACT,
    schemaVersion: 1,
    transactionPolicy: RELEASE_TAIL_TRANSACTION_POLICY,
    subject,
    capabilities,
  };
}

function createEffect(declaration, capability) {
  const identity = capability.operationIdentity;
  const envelope = {
    schema: RELEASE_TAIL_EFFECT_SCHEMA,
    kind: capability.effect.kind,
    transactionRoot: identity.transactionRoot,
    operationId: releaseTailRoot(identity),
    capabilityId: capability.id,
    executor: capability.executor,
    adapter: capability.adapter,
    subjectRoot: identity.subjectRoot,
    targetRoot: identity.targetRoot,
    attemptKey: identity.attemptKey,
    subject: declaration.subject,
    artifactRoles: capability.artifactRoles,
    destination: capability.destination,
    channelPolicy: capability.channelPolicy,
    activationPolicy: capability.activationPolicy,
    readbackPredicates: capability.readbackPredicates,
    idempotency: capability.idempotency,
    retry: capability.retry,
    evidenceRequirements: capability.evidenceRequirements,
  };
  return { ...envelope, effectRoot: releaseTailRoot(envelope) };
}

export function compileReleaseTailDeclaration(input) {
  const declaration = parseReleaseTailDeclaration(input);
  const effects = declaration.capabilities.map((capability) =>
    createEffect(declaration, capability),
  );
  const plan = {
    schema: "kungfu.buildchain.release-tail.effect-plan/v1",
    transactionPolicy: RELEASE_TAIL_TRANSACTION_POLICY,
    transactionRoot:
      declaration.capabilities[0].operationIdentity.transactionRoot,
    declarationRoot: releaseTailRoot(declaration),
    subject: declaration.subject,
    operationOrder: effects.map((effect) => effect.operationId),
    effects,
  };
  return { ...plan, planRoot: releaseTailRoot(plan) };
}

export function validateReleaseTailEffectPlan(plan) {
  const issues = [];
  try {
    exactFields(plan, EFFECT_PLAN_FIELDS, "effect plan");
    rejectExecutableKeys(plan);
    exactFields(plan.subject, SUBJECT_FIELDS, "effect plan subject");
  } catch (error) {
    issues.push(error.message);
  }
  if (plan?.schema !== "kungfu.buildchain.release-tail.effect-plan/v1") {
    issues.push("effect plan schema is invalid");
  }
  if (plan?.transactionPolicy !== RELEASE_TAIL_TRANSACTION_POLICY) {
    issues.push("effect plan transactionPolicy is invalid");
  }
  for (const field of ["transactionRoot", "declarationRoot", "planRoot"]) {
    if (!ROOT.test(plan?.[field] || "")) issues.push(`${field} is invalid`);
  }
  if (!Array.isArray(plan?.effects) || plan.effects.length === 0) {
    issues.push("effects must be a non-empty array");
  } else {
    const operationIds = [];
    for (const effect of plan.effects) {
      try {
        exactFields(effect, EFFECT_FIELDS, `effect ${effect?.capabilityId}`);
      } catch (error) {
        issues.push(error.message);
      }
      const descriptor = CAPABILITY_BY_ID.get(effect?.capabilityId);
      if (!descriptor) {
        issues.push(
          `unsupported effect capability: ${effect?.capabilityId || "<empty>"}`,
        );
        continue;
      }
      if (
        effect.schema !== RELEASE_TAIL_EFFECT_SCHEMA ||
        effect.kind !== descriptor.effectKind ||
        effect.executor !== descriptor.executor ||
        effect.adapter !== descriptor.adapter
      ) {
        issues.push(
          `effect ${effect.capabilityId} does not match the capability registry`,
        );
      }
      if (effect.transactionRoot !== plan.transactionRoot) {
        issues.push(`effect ${effect.capabilityId} transactionRoot mismatch`);
      }
      if (
        releaseTailStableJson(effect.subject) !==
        releaseTailStableJson(plan.subject)
      ) {
        issues.push(`effect ${effect.capabilityId} subject mismatch`);
      }
      if (
        !ROOT.test(effect.subjectRoot || "") ||
        !ROOT.test(effect.targetRoot || "")
      ) {
        issues.push(
          `effect ${effect.capabilityId} has an invalid subject or target root`,
        );
      }
      if (
        effect.operationId !==
        releaseTailRoot({
          transactionRoot: effect.transactionRoot,
          capabilityId: effect.capabilityId,
          subjectRoot: effect.subjectRoot,
          targetRoot: effect.targetRoot,
          attemptKey: effect.attemptKey,
        })
      ) {
        issues.push(`effect ${effect.capabilityId} operationId mismatch`);
      }
      const effectBody = structuredClone(effect);
      delete effectBody.effectRoot;
      if (effect.effectRoot !== releaseTailRoot(effectBody)) {
        issues.push(`effect ${effect.capabilityId} effectRoot mismatch`);
      }
      operationIds.push(effect.operationId);
    }
    if (new Set(operationIds).size !== operationIds.length) {
      issues.push("effect plan operation ids must be unique");
    }
    if (operationIds.join("\n") !== (plan.operationOrder || []).join("\n")) {
      issues.push("effect plan operationOrder mismatch");
    }
  }
  const body = structuredClone(plan || {});
  delete body.planRoot;
  if (plan?.planRoot !== releaseTailRoot(body))
    issues.push("planRoot mismatch");
  return { valid: issues.length === 0, issues };
}

export function createReleaseTailTransaction(input) {
  const plan = input?.schema?.endsWith("effect-plan/v1")
    ? structuredClone(input)
    : compileReleaseTailDeclaration(input);
  const planValidation = validateReleaseTailEffectPlan(plan);
  if (!planValidation.valid) {
    throw new Error(
      `invalid release-tail effect plan: ${planValidation.issues.join("; ")}`,
    );
  }
  const transaction = {
    schema: RELEASE_TAIL_TRANSACTION_SCHEMA,
    transactionPolicy: RELEASE_TAIL_TRANSACTION_POLICY,
    transactionRoot: plan.transactionRoot,
    declarationRoot: plan.declarationRoot,
    planRoot: plan.planRoot,
    subject: plan.subject,
    state: "prepared",
    operationOrder: plan.operationOrder,
    operations: plan.effects.map((effect) => ({
      operationId: effect.operationId,
      capabilityId: effect.capabilityId,
      effect,
      status: "pending",
      effectAttempts: 0,
      readbackAttempts: 0,
      observationRoots: [],
      receipt: null,
    })),
    observations: [],
    receipts: [],
    failure: null,
  };
  return refreshTransaction(transaction);
}

function transactionBody(transaction) {
  const copy = structuredClone(transaction);
  delete copy.stateRoot;
  return copy;
}

function refreshTransaction(transaction) {
  transaction.stateRoot = releaseTailRoot(transactionBody(transaction));
  return transaction;
}

export function validateReleaseTailTransaction(transaction) {
  const issues = [];
  if (transaction?.schema !== RELEASE_TAIL_TRANSACTION_SCHEMA) {
    issues.push(`schema must be ${RELEASE_TAIL_TRANSACTION_SCHEMA}`);
  }
  if (!RELEASE_TAIL_STATES.includes(transaction?.state))
    issues.push("state is invalid");
  if (!ROOT.test(transaction?.transactionRoot || "")) {
    issues.push("transactionRoot is invalid");
  }
  if (!ROOT.test(transaction?.declarationRoot || "")) {
    issues.push("declarationRoot is invalid");
  }
  if (!ROOT.test(transaction?.planRoot || ""))
    issues.push("planRoot is invalid");
  if (!Array.isArray(transaction?.operations)) {
    issues.push("operations must be an array");
  } else {
    const ids = transaction.operations.map((entry) => entry.operationId);
    if (ids.join("\n") !== (transaction.operationOrder || []).join("\n")) {
      issues.push("operations must preserve operationOrder");
    }
    for (const operation of transaction.operations) {
      if (!["pending", "complete", "failed"].includes(operation.status)) {
        issues.push(
          `operation ${operation.operationId || "<unknown>"} status is invalid`,
        );
      }
      if (
        !Number.isSafeInteger(operation.effectAttempts) ||
        operation.effectAttempts < 0
      ) {
        issues.push(
          `operation ${operation.operationId || "<unknown>"} effectAttempts is invalid`,
        );
      }
      if (
        !Number.isSafeInteger(operation.readbackAttempts) ||
        operation.readbackAttempts < 0
      ) {
        issues.push(
          `operation ${operation.operationId || "<unknown>"} readbackAttempts is invalid`,
        );
      }
      if (!Array.isArray(operation.observationRoots)) {
        issues.push(
          `operation ${operation.operationId || "<unknown>"} observationRoots is invalid`,
        );
      }
    }
  }
  if (!Array.isArray(transaction?.observations)) {
    issues.push("observations must be an array");
  } else {
    for (const observation of transaction.observations) {
      const body = structuredClone(observation);
      delete body.observationRoot;
      if (observation.observationRoot !== releaseTailRoot(body)) {
        issues.push(
          `observation ${observation.operationId || "<unknown>"} root mismatch`,
        );
      }
    }
  }
  if (!Array.isArray(transaction?.receipts)) {
    issues.push("receipts must be an array");
  } else {
    for (const receipt of transaction.receipts) {
      const body = structuredClone(receipt);
      delete body.receiptRoot;
      if (receipt.receiptRoot !== releaseTailRoot(body)) {
        issues.push(
          `receipt ${receipt.operationId || "<unknown>"} root mismatch`,
        );
      }
    }
  }
  if (
    transaction?.stateRoot !==
    releaseTailRoot(transactionBody(transaction || {}))
  ) {
    issues.push("stateRoot mismatch");
  }
  return { valid: issues.length === 0, issues };
}

export function readReleaseTailTransaction(filePath) {
  const transaction = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const validation = validateReleaseTailTransaction(transaction);
  if (!validation.valid) {
    throw new Error(
      `invalid release-tail transaction: ${validation.issues.join("; ")}`,
    );
  }
  return transaction;
}

export function writeReleaseTailTransaction(filePath, transaction) {
  const validation = validateReleaseTailTransaction(transaction);
  if (!validation.valid) {
    throw new Error(
      `invalid release-tail transaction: ${validation.issues.join("; ")}`,
    );
  }
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(transaction, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, resolved);
  return resolved;
}

function normalizeAdapterObservation(effect, raw, phase) {
  const value = raw && typeof raw === "object" ? raw : {};
  const outcome = oneOf(
    value.outcome || "transient",
    ["observed", "absent", "transient", "conflict"],
    `${effect.capabilityId} adapter observation outcome`,
  );
  const subjectRoot = value.subjectRoot
    ? exactRoot(
        value.subjectRoot,
        `${effect.capabilityId} observation subjectRoot`,
      )
    : "";
  const targetRoot = value.targetRoot
    ? exactRoot(
        value.targetRoot,
        `${effect.capabilityId} observation targetRoot`,
      )
    : "";
  let status = outcome;
  if (outcome === "observed") {
    status =
      subjectRoot === effect.subjectRoot && targetRoot === effect.targetRoot
        ? "matched"
        : "stale";
  }
  const evidenceRoots = Array.isArray(value.evidenceRoots)
    ? [
        ...new Set(
          value.evidenceRoots.map((root, index) =>
            exactRoot(
              root,
              `${effect.capabilityId} observation evidenceRoots[${index}]`,
            ),
          ),
        ),
      ].sort()
    : [];
  const observation = {
    schema: RELEASE_TAIL_OBSERVATION_SCHEMA,
    kind: CAPABILITY_BY_ID.get(effect.capabilityId).observationKind,
    transactionRoot: effect.transactionRoot,
    operationId: effect.operationId,
    capabilityId: effect.capabilityId,
    phase,
    status,
    subjectRoot,
    targetRoot,
    providerCode: /^[a-z0-9][a-z0-9._-]{0,159}$/u.test(
      String(value.providerCode || status),
    )
      ? String(value.providerCode || status)
      : "provider-observation",
    evidenceRoots,
  };
  return { ...observation, observationRoot: releaseTailRoot(observation) };
}

function createReceipt(operation, action, observation) {
  const effect = operation.effect;
  const body = {
    schema: RELEASE_TAIL_RECEIPT_SCHEMA,
    kind: CAPABILITY_BY_ID.get(effect.capabilityId).receiptKind,
    transactionRoot: effect.transactionRoot,
    operationId: effect.operationId,
    capabilityId: effect.capabilityId,
    subjectRoot: effect.subjectRoot,
    targetRoot: effect.targetRoot,
    effectRoot: effect.effectRoot,
    action,
    effectAttempts: operation.effectAttempts,
    readbackAttempts: operation.readbackAttempts,
    observationRoots: [...operation.observationRoots],
    evidenceRoots: observation.evidenceRoots,
  };
  return { ...body, receiptRoot: releaseTailRoot(body) };
}

function capabilityForOperation(operation) {
  return CAPABILITY_BY_ID.get(operation.capabilityId);
}

function nextPendingOperation(transaction) {
  return (
    transaction.operations.find((entry) => entry.status === "pending") || null
  );
}

function adapterFor(adapters, operation) {
  const descriptor = capabilityForOperation(operation);
  const adapter = adapters?.[descriptor.adapter];
  if (
    !adapter ||
    typeof adapter.readback !== "function" ||
    typeof adapter.apply !== "function"
  ) {
    throw new Error(
      `release-tail adapter '${descriptor.adapter}' must provide readback and apply`,
    );
  }
  return adapter;
}

function recordObservation(transaction, operationId, observation) {
  const next = structuredClone(transaction);
  const operation = next.operations.find(
    (entry) => entry.operationId === operationId,
  );
  if (!operation)
    throw new Error(`unknown release-tail operation: ${operationId}`);
  operation.observationRoots.push(observation.observationRoot);
  next.observations.push(observation);
  return refreshTransaction(next);
}

function completeOperation(transaction, operationId, action, observation) {
  const next = structuredClone(transaction);
  const operation = next.operations.find(
    (entry) => entry.operationId === operationId,
  );
  operation.status = "complete";
  operation.receipt = createReceipt(operation, action, observation);
  next.receipts = next.operations
    .filter((entry) => entry.receipt)
    .map((entry) => entry.receipt);
  next.failure = null;
  next.state = nextPendingOperation(next)
    ? capabilityForOperation(nextPendingOperation(next)).transactionState
    : "complete";
  return refreshTransaction(next);
}

function failOperation(
  transaction,
  operationId,
  state,
  code,
  observation = null,
) {
  const next = structuredClone(transaction);
  const operation = next.operations.find(
    (entry) => entry.operationId === operationId,
  );
  operation.status = "failed";
  next.state = state;
  next.failure = {
    operationId,
    capabilityId: operation.capabilityId,
    code,
    observationRoot: observation?.observationRoot || "",
  };
  return refreshTransaction(next);
}

async function checkpoint(callback, transaction) {
  if (callback) await callback(structuredClone(transaction));
}

export async function executeReleaseTailTransaction(
  transaction,
  { adapters, checkpoint: checkpointCallback } = {},
) {
  const validation = validateReleaseTailTransaction(transaction);
  if (!validation.valid) {
    throw new Error(
      `invalid release-tail transaction: ${validation.issues.join("; ")}`,
    );
  }
  if (TERMINAL_STATES.has(transaction.state))
    return structuredClone(transaction);
  let current = structuredClone(transaction);
  while (nextPendingOperation(current)) {
    const pending = nextPendingOperation(current);
    const capability = CAPABILITY_BY_ID.get(pending.capabilityId);
    const adapter = adapterFor(adapters, pending);
    current.state = capability.transactionState;
    current = refreshTransaction(current);
    await checkpoint(checkpointCallback, current);

    const policy = pending.effect.retry;
    const maxCycles = 1 + policy.localAttempts;
    let applied = pending.effectAttempts > 0;
    let completed = false;

    for (let cycle = 0; cycle < maxCycles; cycle += 1) {
      current.state = "reading-back";
      current = refreshTransaction(current);
      await checkpoint(checkpointCallback, current);
      let rawReadback;
      try {
        rawReadback = await adapter.readback(structuredClone(pending.effect));
      } catch (error) {
        rawReadback = {
          outcome:
            error?.releaseTailClass === "conflict" ? "conflict" : "transient",
          providerCode: error?.releaseTailCode || "readback-error",
        };
      }
      let operation = current.operations.find(
        (entry) => entry.operationId === pending.operationId,
      );
      operation.readbackAttempts += 1;
      current = refreshTransaction(current);
      const preObservation = normalizeAdapterObservation(
        pending.effect,
        rawReadback,
        applied ? "retry-readback" : "pre-effect-readback",
      );
      current = recordObservation(current, pending.operationId, preObservation);
      await checkpoint(checkpointCallback, current);
      if (preObservation.status === "matched") {
        current = completeOperation(
          current,
          pending.operationId,
          applied ? "applied-and-observed" : "observed-existing",
          preObservation,
        );
        await checkpoint(checkpointCallback, current);
        completed = true;
        break;
      }
      if (preObservation.status === "conflict") {
        current = failOperation(
          current,
          pending.operationId,
          "terminal-failure",
          "provider-conflict",
          preObservation,
        );
        await checkpoint(checkpointCallback, current);
        return current;
      }
      if (preObservation.status === "stale") {
        current = failOperation(
          current,
          pending.operationId,
          "repair-required",
          "stale-readback",
          preObservation,
        );
        await checkpoint(checkpointCallback, current);
        return current;
      }
      if (preObservation.status === "transient") {
        if (cycle + 1 < maxCycles) continue;
        break;
      }
      if (applied && policy.class !== "provider-transient") continue;

      operation = current.operations.find(
        (entry) => entry.operationId === pending.operationId,
      );
      operation.effectAttempts += 1;
      current = refreshTransaction(current);
      await checkpoint(checkpointCallback, current);
      try {
        await adapter.apply(structuredClone(pending.effect));
      } catch (error) {
        if (error?.releaseTailClass === "conflict") {
          current = failOperation(
            current,
            pending.operationId,
            "terminal-failure",
            error?.releaseTailCode || "provider-conflict",
          );
          await checkpoint(checkpointCallback, current);
          return current;
        }
      }
      applied = true;

      current.state = "reading-back";
      current = refreshTransaction(current);
      await checkpoint(checkpointCallback, current);
      let postRaw;
      try {
        postRaw = await adapter.readback(structuredClone(pending.effect));
      } catch (error) {
        postRaw = {
          outcome:
            error?.releaseTailClass === "conflict" ? "conflict" : "transient",
          providerCode: error?.releaseTailCode || "post-effect-readback-error",
        };
      }
      operation = current.operations.find(
        (entry) => entry.operationId === pending.operationId,
      );
      operation.readbackAttempts += 1;
      current = refreshTransaction(current);
      const postObservation = normalizeAdapterObservation(
        pending.effect,
        postRaw,
        "post-effect-readback",
      );
      current = recordObservation(
        current,
        pending.operationId,
        postObservation,
      );
      await checkpoint(checkpointCallback, current);
      if (postObservation.status === "matched") {
        current = completeOperation(
          current,
          pending.operationId,
          "applied-and-observed",
          postObservation,
        );
        await checkpoint(checkpointCallback, current);
        completed = true;
        break;
      }
      if (postObservation.status === "conflict") {
        current = failOperation(
          current,
          pending.operationId,
          "terminal-failure",
          "provider-conflict",
          postObservation,
        );
        await checkpoint(checkpointCallback, current);
        return current;
      }
      if (postObservation.status === "stale") {
        current = failOperation(
          current,
          pending.operationId,
          "repair-required",
          "stale-readback",
          postObservation,
        );
        await checkpoint(checkpointCallback, current);
        return current;
      }
    }

    if (!completed) {
      current = failOperation(
        current,
        pending.operationId,
        policy.exhausted,
        "local-retry-exhausted",
      );
      await checkpoint(checkpointCallback, current);
      return current;
    }
  }
  return current;
}

export function releaseTailRetryPolicyFromDeclaration(input) {
  const declaration = parseReleaseTailDeclaration(input);
  return Object.fromEntries(
    declaration.capabilities.map((capability) => [
      capability.id,
      capability.retry,
    ]),
  );
}

export function createReleaseTailAdapterSet(declaration, adapters) {
  const parsed = parseReleaseTailDeclaration(declaration);
  const result = { declarations: {} };
  for (const capability of parsed.capabilities) {
    const adapter = adapters?.[capability.adapter];
    if (!adapter)
      throw new Error(`missing release-tail adapter: ${capability.adapter}`);
    result[capability.adapter] = adapter;
    result.declarations[capability.id] = { retry: capability.retry };
  }
  return result;
}
