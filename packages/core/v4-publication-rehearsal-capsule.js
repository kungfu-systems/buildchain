import {
  RELEASE_TAIL_TRANSACTION_POLICY,
  compileReleaseTailDeclaration,
  createReleaseTailTransaction,
  parseReleaseTailDeclaration,
  releaseTailRoot,
  validateReleaseTailTransaction,
} from "./release-tail-provider-plane.js";
import {
  V4PublicationRehearsalFault,
  publicationRehearsalByteSorted as byteSorted,
  publicationRehearsalExactKeys as exactKeys,
  publicationRehearsalFault as fault,
  publicationRehearsalRelativePath as relativePath,
  publicationRehearsalRoot as root,
  publicationRehearsalText as text,
  publicationRehearsalToken as token,
  validateV4PublicationRehearsalProviderBindings,
} from "./v4-publication-rehearsal-provider-bindings.js";

export {
  V4PublicationRehearsalFault,
  exactKeys as assertPublicationRehearsalExactKeys,
  fault as publicationRehearsalFault,
  root as publicationRehearsalRoot,
  validateV4PublicationRehearsalProviderBindings,
};

export const V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT =
  "buildchain-v4-publication-rehearsal-capsule/v1";
export const V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT =
  "buildchain-v4-publication-rehearsal-evidence/v1";
export const V4_PUBLICATION_REHEARSAL_AUTHORITY_CONTRACT =
  "buildchain-v4-publication-rehearsal-authority/v1";
export const V4_PUBLICATION_REHEARSAL_PROVIDER_POLICY_CONTRACT =
  "buildchain-v4-publication-rehearsal-provider-policy/v1";
export const V4_PUBLICATION_REHEARSAL_CORE_VERSION =
  RELEASE_TAIL_TRANSACTION_POLICY;

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const TOKEN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const MODES = new Set(["simulate", "replay", "provider"]);

function sourceRoot(source) {
  return releaseTailRoot({
    repository: source.repository,
    revision: source.revision,
  });
}

function candidateRoot(files) {
  return releaseTailRoot(
    files.map(({ role, path: filePath, size, root: fileRoot }) => ({
      role,
      path: filePath,
      size,
      root: fileRoot,
    })),
  );
}

function policyPayload(policy) {
  return {
    schema: policy.schema,
    effectDefault: policy.effectDefault,
    allowedCapabilityIds: policy.allowedCapabilityIds,
    allowedAdapters: policy.allowedAdapters,
  };
}

function capsulePayload(capsule) {
  const payload = structuredClone(capsule);
  delete payload.capsuleRoot;
  return payload;
}

function normalizeFile(value, index) {
  const location = `$/files/${index}`;
  exactKeys(value, ["role", "path", "size", "root"], location);
  if (!Number.isSafeInteger(value.size) || value.size < 0)
    fault(
      "invalid-publication-rehearsal-file",
      `${location}/size`,
      "non-negative safe integer required",
    );
  return {
    role: token(value.role, `${location}/role`),
    path: relativePath(value.path, `${location}/path`),
    size: value.size,
    root: root(value.root, `${location}/root`),
  };
}

function normalizeBinding(value, location) {
  exactKeys(value, ["path", "root"], location);
  return {
    path: relativePath(value.path, `${location}/path`),
    root: root(value.root, `${location}/root`),
  };
}

function normalizeCandidateInputs(value) {
  exactKeys(value.candidate, ["root"], "$/candidate");
  root(value.candidate.root, "$/candidate/root");
  if (!Array.isArray(value.files) || value.files.length === 0)
    fault(
      "invalid-publication-rehearsal-files",
      "$/files",
      "non-empty file inventory required",
    );
  const files = value.files.map(normalizeFile);
  const paths = files.map((entry) => entry.path);
  if (
    JSON.stringify(paths) !==
      JSON.stringify(
        [...new Set(paths)].sort((left, right) =>
          Buffer.from(left).compare(Buffer.from(right)),
        ),
      ) ||
    value.candidate.root !== candidateRoot(files)
  )
    fault(
      "publication-rehearsal-candidate-root-mismatch",
      "$/candidate/root",
      "candidate inventory is unordered, duplicated, or drifted",
    );
  const manifest = normalizeBinding(value.manifest, "$/manifest");
  const config = normalizeBinding(value.config, "$/config");
  for (const [name, binding] of Object.entries({ manifest, config }))
    if (
      !files.some(
        (entry) => entry.path === binding.path && entry.root === binding.root,
      )
    )
      fault(
        `publication-rehearsal-${name}-root-mismatch`,
        `$/${name}`,
        `${name} is not bound by the candidate inventory`,
      );
  const providerBindings = validateV4PublicationRehearsalProviderBindings(
    value.providerBindings,
  );
  root(value.providerBindingsRoot, "$/providerBindingsRoot");
  if (value.providerBindingsRoot !== releaseTailRoot(providerBindings))
    fault(
      "publication-rehearsal-provider-bindings-root-mismatch",
      "$/providerBindingsRoot",
      "provider bindings payload drifted",
    );
  const inventoryPaths = new Set(paths);
  const requiredInputs = [
    ...Object.values(providerBindings.artifacts).map(({ path }) => path),
    ...Object.values(providerBindings.documents).map(({ path }) => path),
    ...providerBindings.evidence.inputs,
  ];
  for (const inputPath of requiredInputs)
    if (!inventoryPaths.has(inputPath))
      fault(
        "publication-rehearsal-provider-binding-file-missing",
        "$/providerBindings",
        `provider input is absent from files: ${inputPath}`,
      );
  return { files, manifest, config, providerBindings };
}

function normalizeProviderPolicy(value, declaration) {
  exactKeys(
    value,
    [
      "schema",
      "effectDefault",
      "allowedCapabilityIds",
      "allowedAdapters",
      "root",
    ],
    "$/providerPolicy",
  );
  if (
    value.schema !== V4_PUBLICATION_REHEARSAL_PROVIDER_POLICY_CONTRACT ||
    value.effectDefault !== "disabled"
  )
    fault(
      "invalid-publication-rehearsal-provider-policy",
      "$/providerPolicy",
      "provider rehearsal effects must default to disabled",
    );
  const capabilityIds = byteSorted(
    value.allowedCapabilityIds,
    "$/providerPolicy/allowedCapabilityIds",
    text,
  );
  const adapters = byteSorted(
    value.allowedAdapters,
    "$/providerPolicy/allowedAdapters",
    token,
  );
  const expectedCapabilityIds = declaration.capabilities
    .map(({ id }) => id)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const expectedAdapters = [
    ...new Set(declaration.capabilities.map(({ adapter }) => adapter)),
  ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (
    JSON.stringify(capabilityIds) !== JSON.stringify(expectedCapabilityIds) ||
    JSON.stringify(adapters) !== JSON.stringify(expectedAdapters)
  )
    fault(
      "publication-rehearsal-provider-policy-mismatch",
      "$/providerPolicy",
      "policy must enumerate the exact shared-core capabilities and adapters",
    );
  const normalized = {
    schema: value.schema,
    effectDefault: value.effectDefault,
    allowedCapabilityIds: capabilityIds,
    allowedAdapters: adapters,
    root: root(value.root, "$/providerPolicy/root"),
  };
  if (normalized.root !== releaseTailRoot(policyPayload(normalized)))
    fault(
      "publication-rehearsal-provider-policy-root-mismatch",
      "$/providerPolicy/root",
      "provider policy root drifted",
    );
  return normalized;
}

function normalizeObservation(value, index, operationIds) {
  const location = `$/expectedObservations/entries/${index}`;
  exactKeys(value, ["operationId", "readbacks", "apply"], location);
  const operationId = root(value.operationId, `${location}/operationId`);
  if (!operationIds.has(operationId))
    fault(
      "publication-rehearsal-observation-operation-mismatch",
      `${location}/operationId`,
      "unknown operation",
    );
  if (!Array.isArray(value.readbacks) || value.readbacks.length === 0)
    fault(
      "invalid-publication-rehearsal-observation",
      `${location}/readbacks`,
      "non-empty readback sequence required",
    );
  for (const [readbackIndex, readback] of value.readbacks.entries()) {
    exactKeys(
      readback,
      ["outcome", "subjectRoot", "targetRoot", "evidenceRoots", "providerCode"],
      `${location}/readbacks/${readbackIndex}`,
    );
    if (
      !new Set(["observed", "absent", "transient", "conflict"]).has(
        readback.outcome,
      )
    )
      fault(
        "invalid-publication-rehearsal-observation",
        `${location}/readbacks/${readbackIndex}/outcome`,
        "unsupported outcome",
      );
    if (readback.subjectRoot)
      root(
        readback.subjectRoot,
        `${location}/readbacks/${readbackIndex}/subjectRoot`,
      );
    if (readback.targetRoot)
      root(
        readback.targetRoot,
        `${location}/readbacks/${readbackIndex}/targetRoot`,
      );
    byteSorted(
      readback.evidenceRoots,
      `${location}/readbacks/${readbackIndex}/evidenceRoots`,
      root,
      true,
    );
    text(
      readback.providerCode,
      `${location}/readbacks/${readbackIndex}/providerCode`,
    );
  }
  exactKeys(
    value.apply,
    ["outcome", "code", "classification"],
    `${location}/apply`,
  );
  if (!new Set(["applied", "transient", "conflict"]).has(value.apply.outcome))
    fault(
      "invalid-publication-rehearsal-observation",
      `${location}/apply/outcome`,
      "unsupported apply outcome",
    );
  text(value.apply.code, `${location}/apply/code`);
  text(value.apply.classification, `${location}/apply/classification`);
  return structuredClone(value);
}

export function createV4PublicationRehearsalProviderPolicy(declarationInput) {
  const declaration = parseReleaseTailDeclaration(declarationInput);
  const body = {
    schema: V4_PUBLICATION_REHEARSAL_PROVIDER_POLICY_CONTRACT,
    effectDefault: "disabled",
    allowedCapabilityIds: declaration.capabilities
      .map(({ id }) => id)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    allowedAdapters: [
      ...new Set(declaration.capabilities.map(({ adapter }) => adapter)),
    ].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
  };
  return { ...body, root: releaseTailRoot(body) };
}

export function createV4PublicationRehearsalCapsule(input) {
  const declaration = parseReleaseTailDeclaration(input.declaration);
  const transaction =
    input.transaction || createReleaseTailTransaction(declaration);
  const files = structuredClone(input.files || []).sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  const source = {
    repository: text(input.source?.repository, "$/source/repository"),
    revision: text(input.source?.revision, "$/source/revision"),
  };
  const policy =
    input.providerPolicy ||
    createV4PublicationRehearsalProviderPolicy(declaration);
  const observations = structuredClone(input.expectedObservations || []);
  const providerBindings = validateV4PublicationRehearsalProviderBindings(
    input.providerBindings,
  );
  const body = {
    schema: V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    coreVersion: V4_PUBLICATION_REHEARSAL_CORE_VERSION,
    source: { ...source, root: sourceRoot(source) },
    candidate: { root: candidateRoot(files) },
    manifest: structuredClone(input.manifest),
    config: structuredClone(input.config),
    providerBindings,
    providerBindingsRoot: releaseTailRoot(providerBindings),
    providerPolicy: structuredClone(policy),
    expectedObservations: {
      entries: observations,
      root: releaseTailRoot(observations),
    },
    declaration,
    transaction: structuredClone(transaction),
    files,
  };
  return validateV4PublicationRehearsalCapsule({
    ...body,
    capsuleRoot: releaseTailRoot(body),
  });
}

export function validateV4PublicationRehearsalCapsule(value) {
  exactKeys(
    value,
    [
      "schema",
      "coreVersion",
      "source",
      "candidate",
      "manifest",
      "config",
      "providerBindings",
      "providerBindingsRoot",
      "providerPolicy",
      "expectedObservations",
      "declaration",
      "transaction",
      "files",
      "capsuleRoot",
    ],
    "$",
  );
  if (
    value.schema !== V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT ||
    value.coreVersion !== V4_PUBLICATION_REHEARSAL_CORE_VERSION
  )
    fault(
      "unsupported-publication-rehearsal-core-version",
      "$/coreVersion",
      "capsule must bind the active production release-tail core",
    );
  exactKeys(value.source, ["repository", "revision", "root"], "$/source");
  text(value.source.repository, "$/source/repository");
  if (!SHA.test(value.source.revision))
    fault(
      "invalid-publication-rehearsal-source",
      "$/source/revision",
      "exact lowercase Git SHA required",
    );
  root(value.source.root, "$/source/root");
  if (value.source.root !== sourceRoot(value.source))
    fault(
      "publication-rehearsal-source-root-mismatch",
      "$/source/root",
      "source root drifted",
    );
  const { files, manifest, config, providerBindings } =
    normalizeCandidateInputs(value);
  const declaration = parseReleaseTailDeclaration(value.declaration);
  const plan = compileReleaseTailDeclaration(declaration);
  const transactionValidation = validateReleaseTailTransaction(
    value.transaction,
  );
  const initial = createReleaseTailTransaction(plan);
  if (
    !transactionValidation.valid ||
    value.transaction.declarationRoot !== plan.declarationRoot ||
    value.transaction.planRoot !== plan.planRoot ||
    value.transaction.transactionRoot !== initial.transactionRoot
  )
    fault(
      "publication-rehearsal-core-binding-mismatch",
      "$/transaction",
      "transaction does not belong to the shared production planner",
    );
  const providerPolicy = normalizeProviderPolicy(
    value.providerPolicy,
    declaration,
  );
  exactKeys(
    value.expectedObservations,
    ["entries", "root"],
    "$/expectedObservations",
  );
  if (!Array.isArray(value.expectedObservations.entries))
    fault(
      "invalid-publication-rehearsal-observations",
      "$/expectedObservations/entries",
      "array required",
    );
  const operationIds = new Set(value.transaction.operationOrder);
  const expectedObservations = value.expectedObservations.entries.map(
    (entry, index) => normalizeObservation(entry, index, operationIds),
  );
  if (
    new Set(expectedObservations.map(({ operationId }) => operationId)).size !==
      expectedObservations.length ||
    value.expectedObservations.root !== releaseTailRoot(expectedObservations)
  )
    fault(
      "publication-rehearsal-expected-observation-root-mismatch",
      "$/expectedObservations/root",
      "expected observations are duplicated or drifted",
    );
  root(value.capsuleRoot, "$/capsuleRoot");
  if (value.capsuleRoot !== releaseTailRoot(capsulePayload(value)))
    fault(
      "publication-rehearsal-capsule-root-mismatch",
      "$/capsuleRoot",
      "capsule payload drifted",
    );
  return {
    ...structuredClone(value),
    manifest,
    config,
    providerBindings,
    providerPolicy,
    expectedObservations: {
      entries: expectedObservations,
      root: value.expectedObservations.root,
    },
    declaration,
    files,
  };
}
