import crypto from "node:crypto";

export const UNIVERSAL_WORKFLOW_REQUEST =
  "buildchain.universal-workflow-request/v2";
export const UNIVERSAL_WORKFLOW_ADMISSION_POLICY =
  "buildchain.universal-workflow-admission-policy/v2";
export const UNIVERSAL_WORKFLOW_ADMISSION =
  "buildchain.universal-workflow-admission/v2";
export const UNIVERSAL_WORKFLOW_TERMINAL_RECEIPT =
  "buildchain.universal-workflow-terminal-receipt/v2";
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const TOKEN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TRAIN = /^train\/v4\/v4\.\d+\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MODES = new Set(["stable", "alpha", "train", "exact"]);
const PERMISSIONS = new Set([
  "actions",
  "artifact-metadata",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "id-token",
  "issues",
  "packages",
  "pages",
  "pull-requests",
  "security-events",
  "statuses",
]);
const LEVELS = new Map([
  ["none", 0],
  ["read", 1],
  ["write", 2],
]);
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-object", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fail("invalid-field-set", `${label} has an invalid field set`);
}
function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) fail("required-value", `${label} must be non-empty`);
  return normalized;
}
function exactSha(value, label) {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!EXACT_SHA.test(normalized))
    fail("invalid-exact-sha", `${label} must be an exact lowercase Git SHA`);
  return normalized;
}
function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("invalid-positive-integer", `${label} must be a positive integer`);
  return value;
}
function root(value, label) {
  const normalized = nonEmpty(value, label).toLowerCase();
  if (!ROOT.test(normalized))
    fail("invalid-root", `${label} must be a lowercase sha256 root`);
  return normalized;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .map((key) => [key, canonical(value[key])]),
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
    return value;
  fail("unsupported-json", "value is not canonical JSON");
}
function documentRoot(domain, value) {
  const hash = crypto.createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(`${JSON.stringify(canonical(value))}\n`, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
function sortedValues(values, label, normalize, kind) {
  if (!Array.isArray(values) || values.length === 0)
    fail(`required-${kind}`, `${label} must be a non-empty array`);
  const normalized = values.map((value, index) =>
    normalize(value, `${label}[${index}]`),
  );
  const expected = [...new Set(normalized)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    normalized.length !== expected.length ||
    normalized.some((value, index) => value !== expected[index])
  )
    fail(
      `non-canonical-${kind}`,
      `${label} must be byte-sorted and duplicate-free`,
    );
  return normalized;
}
function token(value, label) {
  const token = nonEmpty(value, label);
  if (!TOKEN.test(token))
    fail("invalid-token", `${label} must be an ASCII token`);
  return token;
}
const sortedRoots = (values, label) =>
  sortedValues(values, label, root, "roots");
const sortedTokens = (values, label) =>
  sortedValues(values, label, token, "tokens");
const sortedStrings = (values, label) =>
  sortedValues(values, label, nonEmpty, "strings");
function permissions(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid-permissions", `${label} must be an object`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!PERMISSIONS.has(key))
      fail("unknown-permission", `${label}.${key} is not governed`);
    const level = nonEmpty(value[key], `${label}.${key}`);
    if (!LEVELS.has(level))
      fail("invalid-permission-level", `${label}.${key} has an invalid level`);
    result[key] = level;
  }
  if (Object.keys(result).length === 0)
    fail("required-permissions", `${label} must not be empty`);
  return result;
}
function repository(value, label) {
  const normalized = nonEmpty(value, label);
  if (!REPOSITORY.test(normalized))
    fail("invalid-repository", `${label} must be an owner/repository slug`);
  return normalized;
}

function workflow(value, label) {
  const normalized = nonEmpty(value, label);
  if (!WORKFLOW.test(normalized))
    fail("invalid-workflow", `${label} must be a tracked workflow path`);
  return normalized;
}

function timestamp(value, label) {
  const normalized = nonEmpty(value, label);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized)
    fail("invalid-timestamp", `${label} must be a canonical UTC timestamp`);
  return normalized;
}

export function validateUniversalWorkflowRequest(value) {
  exactKeys(
    value,
    ["schema", "consumer", "capability", "payload"],
    "request",
  );
  if (value.schema !== UNIVERSAL_WORKFLOW_REQUEST)
    fail("unsupported-request-schema", "request schema is unsupported");
  exactKeys(
    value.consumer,
    ["repository", "workflow", "sourceSha"],
    "request.consumer",
  );
  exactKeys(
    value.capability,
    ["id", "contractRoots", "permissions"],
    "request.capability",
  );
  const capabilityId = nonEmpty(value.capability.id, "request.capability.id");
  if (!TOKEN.test(capabilityId))
    fail("invalid-capability", "request.capability.id must be an ASCII token");
  canonical(value.payload);
  return {
    schema: value.schema,
    consumer: {
      repository: repository(
        value.consumer.repository,
        "request.consumer.repository",
      ),
      workflow: workflow(value.consumer.workflow, "request.consumer.workflow"),
      sourceSha: exactSha(
        value.consumer.sourceSha,
        "request.consumer.sourceSha",
      ),
    },
    capability: {
      id: capabilityId,
      contractRoots: sortedRoots(
        value.capability.contractRoots,
        "request.capability.contractRoots",
      ),
      permissions: permissions(
        value.capability.permissions,
        "request.capability.permissions",
      ),
    },
    payload: canonical(value.payload),
  };
}
export function universalWorkflowRequestRoot(value) {
  return documentRoot(
    "universal-workflow-request",
    validateUniversalWorkflowRequest(value),
  );
}
export function productStateVersion(value, requestedSha) { const sourceSha = exactSha(requestedSha, "requestedSha"), ref = nonEmpty(value?.ref, "productStateRef.ref"), prefix = `refs/heads/buildchain/v4-product-state/${sourceSha}-`; if (!ref.startsWith(prefix)) fail("recovery-state-mismatch", "release recovery product state does not bind the requested source"); const match = ref.slice(prefix.length).match(/^(\d+)-(\d+)-(\d+)(?:-alpha-(\d+))?$/u); if (!match) fail("invalid-recovery-version", "release recovery product state version is invalid"); return `${match[1]}.${match[2]}.${match[3]}${match[4] === undefined ? "" : `-alpha.${match[4]}`}`; }
export function selectFinalizedProductPublicationVersion(value) { const requestedSha = exactSha(value.requestedSha, "requestedSha"), requestedTree = exactSha(value.requestedTree, "requestedTree"), lane = nonEmpty(value.targetRef, "targetRef").match(/^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/u); if (!lane || lane[2] !== lane[3]) fail("invalid-finalization-lane", "product publication finalization target is not a release lane"); const expectedAlpha = lane[1] === "alpha", versions = []; for (const row of Array.isArray(value.recoveryStates) ? value.recoveryStates : []) { const stateRef = row?.stateRef, match = String(stateRef?.ref || "").match(/^refs\/heads\/buildchain\/v4-product-state\/([0-9a-f]{40})-(\d+)-(\d+)-(\d+)(?:-alpha-(\d+))?$/u); if (!match || match[2] !== lane[2] || match[3] !== lane[4]) continue; const stateTree = exactSha(row?.stateCommit?.tree?.sha, "productStateCommit.tree.sha"); if (stateTree !== requestedTree || !new Set(["ahead", "identical"]).has(row.headComparisonStatus)) continue; const sourceSha = exactSha(match[1], "productStateRef.sourceSha"), version = productStateVersion(stateRef, sourceSha), parsed = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/u); if ((parsed[4] !== undefined) !== expectedAlpha) continue; if (stateRef?.object?.type !== "commit" || exactSha(stateRef?.object?.sha, "productStateRef.object.sha") !== exactSha(row?.stateCommit?.sha, "productStateCommit.sha") || row.stateCommit.parents?.length !== 1 || exactSha(row.stateCommit.parents[0]?.sha, "productStateCommit.parents[0].sha") !== sourceSha) fail("finalization-state-mismatch", "product publication finalization state does not bind its source"); if (row.exactTagRef && (row.exactTagRef.ref !== `refs/tags/v${version}` || row.exactTagRef.object?.type !== "commit" || exactSha(row.exactTagRef.object?.sha, "exactTagRef.object.sha") !== sourceSha)) fail("finalization-tag-mismatch", "product publication finalization tag does not bind its source"); versions.push(version); } const selected = [...new Set(versions)].sort(); if (selected.length > 1) fail("finalization-state-ambiguous", `publication head ${requestedSha} matches multiple product versions`); return selected[0] || ""; }
export function selectRecoveredProductPublicationVersion(value) {
  if (value.routeDecision !== "Resume") return ""; const candidateVersion = nonEmpty(value.candidateVersion, "candidateVersion"), version = value.channel === "stable" ? candidateVersion.replace(/-alpha\.\d+$/u, "") : candidateVersion, sourceSha = exactSha(value.requestedSha, "requestedSha"), candidate = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/u); if (!candidate) fail("invalid-recovery-version", "release recovery candidate version is invalid"); if (value.explicitResume) return version;
  const states = Array.isArray(value.recoveryStates) ? value.recoveryStates : []; if (states.length) { const recovered = [...new Set(states.map(({ stateRef, stateCommit, exactTagRef }) => { const selected = productStateVersion(stateRef, sourceSha), parsed = selected.match(/^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/u), parents = stateCommit?.parents || []; if (stateRef?.object?.type !== "commit" || exactSha(stateRef?.object?.sha, "productStateRef.object.sha") !== exactSha(stateCommit?.sha, "productStateCommit.sha") || parents.length !== 1 || exactSha(parents[0]?.sha, "productStateCommit.parents[0].sha") !== sourceSha) fail("recovery-state-mismatch", "release recovery product state commit does not bind the requested source"); if (exactTagRef && (exactTagRef.ref !== `refs/tags/v${selected}` || exactTagRef.object?.type !== "commit" || exactSha(exactTagRef.object?.sha, "exactTagRef.object.sha") !== sourceSha)) fail("recovery-tag-mismatch", "release recovery exact tag does not bind the requested source"); if (parsed[1] !== candidate[1] || parsed[2] !== candidate[2] || parsed[3] !== candidate[3] || (parsed[4] === undefined) !== (candidate[4] === undefined)) fail("recovery-state-mismatch", "release recovery product state is outside the candidate release line"); return selected; }))]; if (recovered.length !== 1) fail("recovery-state-ambiguous", "release recovery requires one exact product publication state; provide an exact transaction identity"); return recovered[0]; }
  if (!value.exactTagRef) fail("recovery-tag-missing", "release recovery requires an exact partial-publication tag"); if (value.exactTagRef.ref !== `refs/tags/v${version}` || value.exactTagRef.object?.type !== "commit" || exactSha(value.exactTagRef.object?.sha, "exactTagRef.object.sha") !== sourceSha) fail("recovery-tag-mismatch", "release recovery exact tag does not bind the requested source");
  return version;
}
function validatePolicy(value) {
  exactKeys(
    value,
    [
      "schema",
      "sourceRepository",
      "consumerAdmission",
      "allowedCapabilities",
      "permissionCeiling",
      "contractRoots",
      "validFrom",
      "expiresAt",
    ],
    "policy",
  );
  if (value.schema !== UNIVERSAL_WORKFLOW_ADMISSION_POLICY)
    fail("unsupported-policy-schema", "policy schema is unsupported");
  const consumerAdmission = nonEmpty(
    value.consumerAdmission,
    "consumer admission",
  );
  if (consumerAdmission !== "verified-caller")
    fail("unsupported-consumer-admission", "unsupported admission");
  const policy = {
    schema: value.schema,
    sourceRepository: repository(
      value.sourceRepository,
      "policy.sourceRepository",
    ),
    consumerAdmission,
    allowedCapabilities: sortedTokens(
      value.allowedCapabilities,
      "policy.allowedCapabilities",
    ),
    permissionCeiling: permissions(
      value.permissionCeiling,
      "policy.permissionCeiling",
    ),
    contractRoots: sortedRoots(value.contractRoots, "policy.contractRoots"),
    validFrom: timestamp(value.validFrom, "policy.validFrom"),
    expiresAt: timestamp(value.expiresAt, "policy.expiresAt"),
  };
  if (Date.parse(policy.validFrom) >= Date.parse(policy.expiresAt))
    fail("invalid-policy-window", "policy validity window is empty");
  return policy;
}

export function universalWorkflowAdmissionRoot(value) {
  return documentRoot("universal-workflow-admission", validatePolicy(value));
}

function assertPermissionCeiling(requested, ceiling) {
  for (const [name, level] of Object.entries(requested)) {
    const allowed = ceiling[name] || "none";
    if (LEVELS.get(level) > LEVELS.get(allowed))
      fail(
        "permission-widening",
        `requested ${name}:${level} exceeds admitted ${name}:${allowed}`,
      );
  }
}

export function admitUniversalWorkflow({ request: requestValue, policy: policyValue, runtime, observedConsumerRepository, observedConsumerSha, observedConsumerWorkflowRef, now } = {}) {
  const request = validateUniversalWorkflowRequest(requestValue);
  const policy = validatePolicy(policyValue);
  const workflowRef = nonEmpty(observedConsumerWorkflowRef, "workflow ref");
  const prefix = `${request.consumer.repository}/${request.consumer.workflow}@`;
  if (request.consumer.repository !== observedConsumerRepository || request.consumer.sourceSha !== exactSha(observedConsumerSha, "observedConsumerSha") || !workflowRef.startsWith(prefix) || workflowRef.length === prefix.length)
    fail("consumer-identity-mismatch", "caller identity mismatch");
  if (!policy.allowedCapabilities.includes(request.capability.id)) fail("capability-not-admitted", "capability is not admitted");
  assertPermissionCeiling(request.capability.permissions, policy.permissionCeiling);
  const observedAt = timestamp(now, "now");
  if (Date.parse(observedAt) < Date.parse(policy.validFrom) || Date.parse(observedAt) >= Date.parse(policy.expiresAt)) fail("stale-admission", "capability policy is outside its validity window");
  return {
    schema: UNIVERSAL_WORKFLOW_ADMISSION,
    status: "admitted",
    requestRoot: universalWorkflowRequestRoot(request),
    admissionRoot: universalWorkflowAdmissionRoot(policy),
    consumerRoot: documentRoot("universal-workflow-consumer", request.consumer),
    capabilityRoot: documentRoot("universal-workflow-capability", request.capability),
    runtime,
    permissions: request.capability.permissions,
    contractRoots: request.capability.contractRoots,
  };
}

export function completeUniversalWorkflow({ admission, resultRoot, status }) {
  exactKeys(
    admission,
    [
      "schema",
      "status",
      "requestRoot",
      "admissionRoot",
      "consumerRoot",
      "capabilityRoot",
      "runtime",
      "permissions",
      "contractRoots",
    ],
    "admission",
  );
  if (
    admission.schema !== UNIVERSAL_WORKFLOW_ADMISSION ||
    admission.status !== "admitted"
  )
    fail("invalid-admission", "terminal receipt requires an admitted request");
  if (!new Set(["succeeded", "failed", "cancelled"]).has(status))
    fail("invalid-terminal-status", "terminal status is unsupported");
  const receipt = {
    schema: UNIVERSAL_WORKFLOW_TERMINAL_RECEIPT,
    status,
    requestRoot: root(admission.requestRoot, "admission.requestRoot"),
    admissionRoot: root(admission.admissionRoot, "admission.admissionRoot"),
    consumerRoot: root(admission.consumerRoot, "admission.consumerRoot"),
    capabilityRoot: root(admission.capabilityRoot, "admission.capabilityRoot"),
    runtime: {
      repository: repository(
        admission.runtime?.repository,
        "admission.runtime.repository",
      ),
      sha: admission.runtime?.sha,
    },
    resultRoot: root(resultRoot, "resultRoot"),
  };
  return {
    ...receipt,
    receiptRoot: documentRoot("universal-workflow-receipt", receipt),
  };
}
