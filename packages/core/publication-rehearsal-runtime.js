import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  compileReleaseTailDeclaration,
  createReleaseTailTransaction,
  executeReleaseTailTransaction,
  parseReleaseTailDeclaration,
  releaseTailRoot,
  validateReleaseTailTransaction,
} from "./release-tail-provider-plane.js";

export const PUBLICATION_REHEARSAL_CAPSULE_CONTRACT =
  "kungfu.buildchain.publication-rehearsal-capsule/v1";
export const PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT =
  "kungfu.buildchain.publication-rehearsal-evidence/v1";
export const PUBLICATION_REHEARSAL_DIAGNOSTIC_CONTRACT =
  "kungfu.buildchain.publication-rehearsal-diagnostic/v1";
export const RELEASE_LOCAL_CONSTRUCTIBILITY_ADR =
  "architecture/decisions/0001-release-local-constructibility.md";
export const RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT =
  "Every non-external release behavior is locally constructible and testable from an explicit content-addressed capsule; no semantic path depends on GitHub runner state.";
export const PUBLICATION_REHEARSAL_COMMAND =
  'buildchain release-tail rehearse --capsule "$PWD/.buildchain/publication/rehearsal-capsule.json" --capsule-root "$PWD/.buildchain/publication/candidate" --mode simulate --state "$PWD/.buildchain/publication/rehearsal-state.json" --evidence "$PWD/.buildchain/publication/rehearsal-evidence.json"';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const MODES = new Set(["simulate", "replay", "provider"]);
const EXTERNAL_EFFECT_KIND = Object.freeze({
  "artifact.publish": "github-release-assets",
  "signed-channel.commit": "https-signed-channel",
  "release.activate": "https-release-activation",
});

export class PublicationRehearsalError extends Error {
  constructor(
    message,
    {
      code = "rehearsal-invalid",
      classification = "input",
      bindingRoot = "",
    } = {},
  ) {
    super(message);
    this.name = "PublicationRehearsalError";
    this.rehearsalCode = code;
    this.rehearsalClass = classification;
    this.bindingRoot = bindingRoot;
  }
}

function fail(message, options) {
  throw new PublicationRehearsalError(message, options);
}

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`, { code: "capsule-shape-invalid" });
  }
  const actual = Object.keys(value).sort().join("\n");
  const expected = [...fields].sort().join("\n");
  if (actual !== expected) {
    fail(`${label} fields must be exactly: ${fields.join(", ")}`, {
      code: "capsule-fields-invalid",
    });
  }
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized)
    fail(`${label} must be a non-empty string`, {
      code: "capsule-field-empty",
    });
  return normalized;
}

function exactRoot(value, label) {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!ROOT.test(normalized))
    fail(`${label} must be a sha256 content root`, {
      code: "capsule-root-invalid",
    });
  return normalized;
}

function safeRelativePath(value, label) {
  const normalized = nonEmpty(value, label);
  if (
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be one unambiguous POSIX relative file path`, {
      code: "capsule-path-ambiguous",
    });
  }
  return normalized;
}

function fileDigest(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function rootedPayload(value) {
  const payload = structuredClone(value);
  delete payload.root;
  return releaseTailRoot(payload);
}

function normalizeFile(entry, index) {
  exactFields(entry, ["role", "path", "size", "root"], `files[${index}]`);
  const size = Number(entry.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    fail(`files[${index}].size must be a non-negative safe integer`, {
      code: "capsule-file-size-invalid",
    });
  }
  return {
    role: nonEmpty(entry.role, `files[${index}].role`),
    path: safeRelativePath(entry.path, `files[${index}].path`),
    size,
    root: exactRoot(entry.root, `files[${index}].root`),
  };
}

function normalizeProviderBindings(value) {
  exactFields(
    value,
    ["schema", "artifacts", "documents", "evidence"],
    "providerBindings",
  );
  if (value.schema !== "kungfu.buildchain.release-tail.provider-bindings/v1") {
    fail("providerBindings.schema is not supported", {
      code: "provider-bindings-schema-invalid",
    });
  }
  const artifacts = {};
  for (const role of Object.keys(value.artifacts || {}).sort()) {
    const binding = value.artifacts[role];
    exactFields(
      binding,
      ["path", "name"],
      `providerBindings.artifacts.${role}`,
    );
    artifacts[role] = {
      path: safeRelativePath(
        binding.path,
        `providerBindings.artifacts.${role}.path`,
      ),
      name: nonEmpty(binding.name, `providerBindings.artifacts.${role}.name`),
    };
  }
  const documents = {};
  for (const capabilityId of Object.keys(value.documents || {}).sort()) {
    const binding = value.documents[capabilityId];
    exactFields(
      binding,
      ["path", "method"],
      `providerBindings.documents.${capabilityId}`,
    );
    if (!["PUT", "POST"].includes(binding.method)) {
      fail(
        `providerBindings.documents.${capabilityId}.method must be PUT or POST`,
        {
          code: "provider-binding-method-invalid",
        },
      );
    }
    documents[capabilityId] = {
      path: safeRelativePath(
        binding.path,
        `providerBindings.documents.${capabilityId}.path`,
      ),
      method: binding.method,
    };
  }
  exactFields(
    value.evidence,
    ["inputs", "output"],
    "providerBindings.evidence",
  );
  if (!Array.isArray(value.evidence.inputs)) {
    fail("providerBindings.evidence.inputs must be an array", {
      code: "provider-bindings-evidence-invalid",
    });
  }
  return {
    schema: value.schema,
    artifacts,
    documents,
    evidence: {
      inputs: value.evidence.inputs.map((entry, index) =>
        safeRelativePath(entry, `providerBindings.evidence.inputs[${index}]`),
      ),
      output: safeRelativePath(
        value.evidence.output,
        "providerBindings.evidence.output",
      ),
    },
  };
}

function normalizeObservationResponse(value, label) {
  exactFields(
    value,
    ["outcome", "subjectRoot", "targetRoot", "evidenceRoots", "providerCode"],
    label,
  );
  if (
    !["observed", "absent", "transient", "conflict"].includes(value.outcome)
  ) {
    fail(`${label}.outcome is invalid`, {
      code: "provider-observation-invalid",
    });
  }
  const roots = Array.isArray(value.evidenceRoots)
    ? value.evidenceRoots.map((root, index) =>
        exactRoot(root, `${label}.evidenceRoots[${index}]`),
      )
    : fail(`${label}.evidenceRoots must be an array`, {
        code: "provider-observation-invalid",
      });
  return {
    outcome: value.outcome,
    subjectRoot: value.subjectRoot
      ? exactRoot(value.subjectRoot, `${label}.subjectRoot`)
      : "",
    targetRoot: value.targetRoot
      ? exactRoot(value.targetRoot, `${label}.targetRoot`)
      : "",
    evidenceRoots: roots,
    providerCode: nonEmpty(value.providerCode, `${label}.providerCode`),
  };
}

function normalizeProviderObservations(value, operationIds) {
  if (!Array.isArray(value))
    fail("providerObservations must be an array", {
      code: "provider-observations-invalid",
    });
  const seen = new Set();
  return value.map((entry, index) => {
    exactFields(
      entry,
      ["operationId", "readbacks", "apply"],
      `providerObservations[${index}]`,
    );
    const operationId = exactRoot(
      entry.operationId,
      `providerObservations[${index}].operationId`,
    );
    if (!operationIds.has(operationId) || seen.has(operationId)) {
      fail(
        `providerObservations[${index}].operationId is unknown or duplicated`,
        {
          code: "provider-observation-operation-invalid",
        },
      );
    }
    seen.add(operationId);
    if (!Array.isArray(entry.readbacks) || entry.readbacks.length === 0) {
      fail(`providerObservations[${index}].readbacks must not be empty`, {
        code: "provider-observations-invalid",
      });
    }
    exactFields(
      entry.apply,
      ["outcome", "code", "classification"],
      `providerObservations[${index}].apply`,
    );
    if (!["applied", "transient", "conflict"].includes(entry.apply.outcome)) {
      fail(`providerObservations[${index}].apply.outcome is invalid`, {
        code: "provider-observations-invalid",
      });
    }
    return {
      operationId,
      readbacks: entry.readbacks.map((response, responseIndex) =>
        normalizeObservationResponse(
          response,
          `providerObservations[${index}].readbacks[${responseIndex}]`,
        ),
      ),
      apply: {
        outcome: entry.apply.outcome,
        code: nonEmpty(
          entry.apply.code,
          `providerObservations[${index}].apply.code`,
        ),
        classification: nonEmpty(
          entry.apply.classification,
          `providerObservations[${index}].apply.classification`,
        ),
      },
    };
  });
}

function expectedExternalEffects(declaration) {
  return declaration.capabilities
    .filter((capability) => capability.executor === "provider-adapter")
    .map((capability) => ({
      capabilityId: capability.id,
      adapter: capability.adapter,
      kind: EXTERNAL_EFFECT_KIND[capability.id] || "undeclared",
    }));
}

function normalizedRuntime(value, declaration) {
  exactFields(
    value,
    ["platform", "declaredEnvironment", "externalEffects"],
    "runtime",
  );
  if (value.platform !== "portable") {
    fail("runtime.platform must be portable", {
      code: "platform-assumption-forbidden",
    });
  }
  if (!Array.isArray(value.declaredEnvironment)) {
    fail("runtime.declaredEnvironment must be an array", {
      code: "environment-declaration-invalid",
    });
  }
  const declaredEnvironment = value.declaredEnvironment.map((entry, index) => {
    const key = nonEmpty(entry, `runtime.declaredEnvironment[${index}]`);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      fail(`runtime.declaredEnvironment[${index}] is invalid`, {
        code: "environment-declaration-invalid",
      });
    }
    return key;
  });
  if (new Set(declaredEnvironment).size !== declaredEnvironment.length) {
    fail("runtime.declaredEnvironment contains duplicates", {
      code: "environment-declaration-invalid",
    });
  }
  if (!Array.isArray(value.externalEffects)) {
    fail("runtime.externalEffects must be an array", {
      code: "external-effects-invalid",
    });
  }
  const externalEffects = value.externalEffects.map((entry, index) => {
    exactFields(
      entry,
      ["capabilityId", "adapter", "kind"],
      `runtime.externalEffects[${index}]`,
    );
    return {
      capabilityId: nonEmpty(
        entry.capabilityId,
        `runtime.externalEffects[${index}].capabilityId`,
      ),
      adapter: nonEmpty(
        entry.adapter,
        `runtime.externalEffects[${index}].adapter`,
      ),
      kind: nonEmpty(entry.kind, `runtime.externalEffects[${index}].kind`),
    };
  });
  if (
    JSON.stringify(externalEffects) !==
    JSON.stringify(expectedExternalEffects(declaration))
  ) {
    fail(
      "runtime.externalEffects must exactly enumerate provider-facing effects",
      {
        code: "undeclared-provider-effect",
      },
    );
  }
  return { platform: "portable", declaredEnvironment, externalEffects };
}

export function createPublicationRehearsalCapsule(input = {}) {
  const declaration = parseReleaseTailDeclaration(input.declaration);
  const transaction =
    input.transaction || createReleaseTailTransaction(declaration);
  const payload = {
    contract: PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    schemaVersion: 1,
    declaration,
    policyRoots: [...(input.policyRoots || [])].sort(),
    passport: structuredClone(input.passport),
    transaction: structuredClone(transaction),
    files: structuredClone(input.files || []).sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    providerBindings: structuredClone(input.providerBindings),
    providerObservations: structuredClone(input.providerObservations || []),
    runtime: structuredClone(
      input.runtime || {
        platform: "portable",
        declaredEnvironment: [],
        externalEffects: expectedExternalEffects(declaration),
      },
    ),
  };
  return normalizePublicationRehearsalCapsule({
    ...payload,
    root: releaseTailRoot(payload),
  });
}

export function normalizePublicationRehearsalCapsule(input) {
  exactFields(
    input,
    [
      "contract",
      "schemaVersion",
      "root",
      "declaration",
      "policyRoots",
      "passport",
      "transaction",
      "files",
      "providerBindings",
      "providerObservations",
      "runtime",
    ],
    "capsule",
  );
  if (
    input.contract !== PUBLICATION_REHEARSAL_CAPSULE_CONTRACT ||
    input.schemaVersion !== 1
  ) {
    fail("capsule contract is not supported", {
      code: "capsule-contract-invalid",
    });
  }
  const declaration = parseReleaseTailDeclaration(input.declaration);
  const plan = compileReleaseTailDeclaration(declaration);
  const transaction = structuredClone(input.transaction);
  const transactionValidation = validateReleaseTailTransaction(transaction);
  if (!transactionValidation.valid) {
    fail(
      `capsule transaction is invalid: ${transactionValidation.issues.join("; ")}`,
      {
        code: "capsule-transaction-invalid",
      },
    );
  }
  const initial = createReleaseTailTransaction(plan);
  if (
    transaction.declarationRoot !== plan.declarationRoot ||
    transaction.planRoot !== plan.planRoot ||
    transaction.transactionRoot !== initial.transactionRoot
  ) {
    fail("capsule transaction does not belong to its declaration", {
      code: "capsule-transaction-binding-mismatch",
    });
  }
  if (!Array.isArray(input.policyRoots) || input.policyRoots.length === 0) {
    fail("capsule policyRoots must not be empty", {
      code: "capsule-policy-roots-invalid",
    });
  }
  const policyRoots = input.policyRoots
    .map((root, index) => exactRoot(root, `policyRoots[${index}]`))
    .sort();
  if (new Set(policyRoots).size !== policyRoots.length) {
    fail("capsule policyRoots contain duplicates", {
      code: "capsule-policy-roots-invalid",
    });
  }
  exactFields(input.passport, ["path", "root"], "passport");
  const passport = {
    path: safeRelativePath(input.passport.path, "passport.path"),
    root: exactRoot(input.passport.root, "passport.root"),
  };
  if (!Array.isArray(input.files) || input.files.length === 0) {
    fail("capsule files must not be empty", { code: "capsule-files-invalid" });
  }
  const files = input.files
    .map(normalizeFile)
    .sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    fail("capsule file paths must be unique", {
      code: "capsule-path-ambiguous",
    });
  }
  if (
    !files.some(
      (entry) => entry.path === passport.path && entry.root === passport.root,
    )
  ) {
    fail("passport binding is not present in the capsule file inventory", {
      code: "passport-binding-mismatch",
    });
  }
  const providerBindings = normalizeProviderBindings(input.providerBindings);
  const inputPaths = new Set(files.map((entry) => entry.path));
  for (const binding of Object.values(providerBindings.artifacts)) {
    if (!inputPaths.has(binding.path))
      fail(`artifact binding is absent from files: ${binding.path}`, {
        code: "provider-binding-file-missing",
      });
  }
  for (const binding of Object.values(providerBindings.documents)) {
    if (!inputPaths.has(binding.path))
      fail(`document binding is absent from files: ${binding.path}`, {
        code: "provider-binding-file-missing",
      });
  }
  for (const inputPath of providerBindings.evidence.inputs) {
    if (!inputPaths.has(inputPath))
      fail(`evidence input is absent from files: ${inputPath}`, {
        code: "provider-binding-file-missing",
      });
  }
  const providerObservations = normalizeProviderObservations(
    input.providerObservations,
    new Set(transaction.operationOrder),
  );
  const runtime = normalizedRuntime(input.runtime, declaration);
  const normalized = {
    contract: PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    schemaVersion: 1,
    root: exactRoot(input.root, "capsule.root"),
    declaration,
    policyRoots,
    passport,
    transaction,
    files,
    providerBindings,
    providerObservations,
    runtime,
  };
  if (normalized.root !== rootedPayload(normalized)) {
    fail("capsule root does not match its canonical payload", {
      code: "capsule-root-mismatch",
    });
  }
  return normalized;
}

function resolveCapsuleFile(
  capsuleRoot,
  relativePath,
  label,
  { mustExist = true } = {},
) {
  const root = fs.realpathSync(capsuleRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    fail(`${label} escapes capsule root`, { code: "capsule-path-ambiguous" });
  }
  if (!mustExist) return resolved;
  if (
    !fs.existsSync(resolved) ||
    !fs.statSync(resolved).isFile() ||
    fs.lstatSync(resolved).isSymbolicLink()
  ) {
    fail(`${label} is missing, non-regular, or symbolic`, {
      code: "capsule-file-missing",
    });
  }
  if (!fs.realpathSync(resolved).startsWith(`${root}${path.sep}`)) {
    fail(`${label} resolves outside capsule root`, {
      code: "capsule-path-ambiguous",
    });
  }
  return resolved;
}

export function verifyPublicationRehearsalCapsule({
  capsule,
  capsuleRoot,
} = {}) {
  const normalized = normalizePublicationRehearsalCapsule(capsule);
  const root = nonEmpty(capsuleRoot, "capsuleRoot");
  if (!path.isAbsolute(root)) {
    fail("capsuleRoot must be an explicit absolute path", {
      code: "implicit-workspace-forbidden",
    });
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail("capsuleRoot must identify an existing directory", {
      code: "capsule-root-missing",
    });
  }
  for (const entry of normalized.files) {
    const filePath = resolveCapsuleFile(root, entry.path, entry.path);
    if (
      fs.statSync(filePath).size !== entry.size ||
      fileDigest(filePath) !== entry.root
    ) {
      fail(`capsule file binding mismatch: ${entry.path}`, {
        code: "capsule-file-tampered",
      });
    }
  }
  return { capsule: normalized, capsuleRoot: fs.realpathSync(root) };
}

function transcriptEntry(operationId, method, value) {
  const body = { operationId, method, value };
  return { ...body, root: releaseTailRoot(body) };
}

function simulationAdapters(declaration, transcript) {
  const state = new Map();
  return Object.fromEntries(
    declaration.capabilities.map((capability) => [
      capability.adapter,
      {
        async readback(effect) {
          const response = state.has(effect.operationId)
            ? {
                outcome: "observed",
                subjectRoot: effect.subjectRoot,
                targetRoot: effect.targetRoot,
                evidenceRoots: [effect.targetRoot],
                providerCode: "simulation-observed",
              }
            : {
                outcome: "absent",
                subjectRoot: "",
                targetRoot: "",
                evidenceRoots: [],
                providerCode: "simulation-absent",
              };
          transcript.push(
            transcriptEntry(effect.operationId, "readback", response),
          );
          return response;
        },
        async apply(effect) {
          state.set(effect.operationId, effect.targetRoot);
          transcript.push(
            transcriptEntry(effect.operationId, "apply", {
              outcome: "simulated",
              code: "simulation-only",
            }),
          );
        },
      },
    ]),
  );
}

function replayAdapters(declaration, observations, transcript) {
  const byOperation = new Map(
    observations.map((entry) => [entry.operationId, { ...entry, index: 0 }]),
  );
  return Object.fromEntries(
    declaration.capabilities.map((capability) => [
      capability.adapter,
      {
        async readback(effect) {
          const record = byOperation.get(effect.operationId);
          if (!record || record.index >= record.readbacks.length) {
            fail(`replay readback is missing for ${effect.operationId}`, {
              code: "replay-exhausted",
              classification: "replay",
            });
          }
          const response = structuredClone(record.readbacks[record.index++]);
          transcript.push(
            transcriptEntry(effect.operationId, "readback", response),
          );
          return response;
        },
        async apply(effect) {
          const record = byOperation.get(effect.operationId);
          if (!record)
            fail(`replay apply is missing for ${effect.operationId}`, {
              code: "replay-exhausted",
              classification: "replay",
            });
          transcript.push(
            transcriptEntry(effect.operationId, "apply", record.apply),
          );
          if (record.apply.outcome !== "applied") {
            const error = new Error("recorded provider apply did not succeed");
            error.releaseTailCode = record.apply.code;
            error.releaseTailClass = record.apply.classification;
            throw error;
          }
        },
      },
    ]),
  );
}

function recordingAdapters(declaration, adapters, transcript) {
  const expected = new Set(
    declaration.capabilities.map((entry) => entry.adapter),
  );
  const provided = Object.keys(adapters || {})
    .filter((key) => key !== "declarations")
    .sort();
  if (provided.join("\n") !== [...expected].sort().join("\n")) {
    fail("provider adapter set must exactly match declared adapters", {
      code: "undeclared-provider-effect",
    });
  }
  return Object.fromEntries(
    declaration.capabilities.map((capability) => {
      const adapter = adapters[capability.adapter];
      if (
        !adapter ||
        typeof adapter.readback !== "function" ||
        typeof adapter.apply !== "function"
      ) {
        fail(`provider adapter is incomplete: ${capability.adapter}`, {
          code: "provider-adapter-missing",
        });
      }
      return [
        capability.adapter,
        {
          async readback(effect) {
            try {
              const response = await adapter.readback(effect);
              transcript.push(
                transcriptEntry(effect.operationId, "readback", response),
              );
              return response;
            } catch (error) {
              transcript.push(
                transcriptEntry(effect.operationId, "readback-error", {
                  code: error?.releaseTailCode || "provider-readback-error",
                  classification: error?.releaseTailClass || "transient",
                }),
              );
              throw error;
            }
          },
          async apply(effect) {
            try {
              await adapter.apply(effect);
              transcript.push(
                transcriptEntry(effect.operationId, "apply", {
                  outcome: "applied",
                  code: "provider-accepted",
                }),
              );
            } catch (error) {
              transcript.push(
                transcriptEntry(effect.operationId, "apply-error", {
                  code: error?.releaseTailCode || "provider-apply-error",
                  classification: error?.releaseTailClass || "transient",
                }),
              );
              throw error;
            }
          },
        },
      ];
    }),
  );
}

function assertEnvironment(capsule, environment) {
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    fail("environment must be an explicit object", {
      code: "environment-input-invalid",
    });
  }
  const actual = Object.keys(environment).sort();
  const declared = [...capsule.runtime.declaredEnvironment].sort();
  const undeclared = actual.filter((key) => !declared.includes(key));
  const missing = declared.filter((key) => !actual.includes(key));
  if (undeclared.length || missing.length) {
    fail(
      `environment keys differ from capsule declaration: undeclared=${undeclared.join(",") || "none"}; missing=${missing.join(",") || "none"}`,
      {
        code: "undeclared-environment",
      },
    );
  }
  return Object.fromEntries(
    actual.map((key) => [key, String(environment[key])]),
  );
}

export function publicationRehearsalBindingRoot(capsule) {
  const normalized = normalizePublicationRehearsalCapsule(capsule);
  const plan = compileReleaseTailDeclaration(normalized.declaration);
  return releaseTailRoot({
    capsuleRoot: normalized.root,
    declarationRoot: plan.declarationRoot,
    planRoot: plan.planRoot,
    transactionRoot: normalized.transaction.transactionRoot,
    policyRoots: normalized.policyRoots,
    passportRoot: normalized.passport.root,
    externalEffects: normalized.runtime.externalEffects,
  });
}

export function publicationRehearsalDiagnostic(error, { capsule } = {}) {
  let bindingRoot = error?.bindingRoot || "";
  if (!bindingRoot && capsule) {
    try {
      bindingRoot = publicationRehearsalBindingRoot(capsule);
    } catch {
      bindingRoot = "";
    }
  }
  const body = {
    contract: PUBLICATION_REHEARSAL_DIAGNOSTIC_CONTRACT,
    status: "rejected",
    errorClass: error?.rehearsalClass || "runtime",
    code: error?.rehearsalCode || "rehearsal-runtime-error",
    bindingRoot,
    message: String(error?.message || "publication rehearsal failed"),
  };
  return { ...body, diagnosticRoot: releaseTailRoot(body) };
}

export async function executePublicationRehearsal({
  capsule,
  capsuleRoot,
  mode = "simulate",
  environment = {},
  adapters = {},
  transaction,
  checkpoint,
} = {}) {
  if (!MODES.has(mode))
    fail(`rehearsal mode is invalid: ${mode}`, {
      code: "rehearsal-mode-invalid",
    });
  const verified = verifyPublicationRehearsalCapsule({ capsule, capsuleRoot });
  const normalized = verified.capsule;
  const explicitEnvironment = assertEnvironment(normalized, environment);
  const bindingRoot = publicationRehearsalBindingRoot(normalized);
  const current = transaction
    ? structuredClone(transaction)
    : structuredClone(normalized.transaction);
  const validation = validateReleaseTailTransaction(current);
  if (!validation.valid)
    fail(`rehearsal transaction is invalid: ${validation.issues.join("; ")}`, {
      code: "capsule-transaction-invalid",
      bindingRoot,
    });
  if (
    current.declarationRoot !== normalized.transaction.declarationRoot ||
    current.planRoot !== normalized.transaction.planRoot ||
    current.transactionRoot !== normalized.transaction.transactionRoot
  ) {
    fail("rehearsal transaction state is bound to another capsule", {
      code: "capsule-transaction-binding-mismatch",
      bindingRoot,
    });
  }
  const transcript = [];
  const selectedAdapters =
    mode === "simulate"
      ? simulationAdapters(normalized.declaration, transcript)
      : mode === "replay"
        ? replayAdapters(
            normalized.declaration,
            normalized.providerObservations,
            transcript,
          )
        : recordingAdapters(normalized.declaration, adapters, transcript);
  const result = await executeReleaseTailTransaction(current, {
    adapters: selectedAdapters,
    checkpoint,
  });
  const transcriptRoot = releaseTailRoot(transcript);
  const body = {
    contract: PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
    status: result.state,
    truth:
      mode === "provider"
        ? "provider-observed"
        : mode === "replay"
          ? "recorded-replay"
          : "simulation-only",
    externalPublicationClaimed: false,
    capsuleRoot: normalized.root,
    bindingRoot,
    environmentRoot: releaseTailRoot(explicitEnvironment),
    transactionRoot: result.transactionRoot,
    stateRoot: result.stateRoot,
    receiptRoots: result.receipts.map((entry) => entry.receiptRoot),
    transcriptRoot,
    transcript,
  };
  return {
    transaction: result,
    evidence: { ...body, evidenceRoot: releaseTailRoot(body) },
  };
}

export function resolvePublicationRehearsalFile(
  capsuleRoot,
  relativePath,
  options,
) {
  return resolveCapsuleFile(
    capsuleRoot,
    safeRelativePath(relativePath, "relativePath"),
    "relativePath",
    options,
  );
}
