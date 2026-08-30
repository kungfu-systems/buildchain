import crypto from "node:crypto";

export const V4_UNIVERSAL_WORKFLOW_REQUEST =
  "kungfu-buildchain-v4-universal-workflow-request/v1";
export const V4_UNIVERSAL_WORKFLOW_ADMISSION_POLICY =
  "kungfu-buildchain-v4-universal-workflow-admission-policy/v1";
export const V4_UNIVERSAL_WORKFLOW_ADMISSION =
  "kungfu-buildchain-v4-universal-workflow-admission/v1";
export const V4_UNIVERSAL_WORKFLOW_TERMINAL_RECEIPT =
  "kungfu-buildchain-v4-universal-workflow-terminal-receipt/v1";

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

export function validateV4UniversalWorkflowRequest(value) {
  exactKeys(
    value,
    ["schema", "mode", "candidate", "consumer", "capability", "payload"],
    "request",
  );
  if (value.schema !== V4_UNIVERSAL_WORKFLOW_REQUEST)
    fail("unsupported-request-schema", "request schema is unsupported");
  if (!MODES.has(value.mode))
    fail("unsupported-mode", "request mode is unsupported");
  exactKeys(
    value.candidate,
    [
      "repository",
      "discoveryRef",
      "expectedSha",
      "admissionRoot",
      "reviewPullRequest",
    ],
    "request.candidate",
  );
  const candidateRepository = repository(
    value.candidate.repository,
    "request.candidate.repository",
  );
  if (candidateRepository !== "kungfu-systems/buildchain")
    fail(
      "untrusted-candidate-repository",
      "candidate repository must be kungfu-systems/buildchain",
    );
  const discoveryRef = nonEmpty(
    value.candidate.discoveryRef,
    "request.candidate.discoveryRef",
  ).replace(/^refs\/(?:heads|tags)\//u, "");
  if (value.mode === "train" && !TRAIN.test(discoveryRef))
    fail("invalid-train-ref", "train mode requires a governed v4 Train ref");
  if (value.mode === "exact" && !EXACT_SHA.test(discoveryRef.toLowerCase()))
    fail("invalid-exact-ref", "exact mode requires an exact Git SHA selector");
  if (value.mode === "alpha" && discoveryRef !== "v4-alpha")
    fail("invalid-alpha-ref", "alpha mode requires v4-alpha discovery");
  if (value.mode === "stable" && discoveryRef !== "v4")
    fail("invalid-stable-ref", "stable mode requires v4 discovery");
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
    mode: value.mode,
    candidate: {
      repository: candidateRepository,
      discoveryRef,
      expectedSha: exactSha(
        value.candidate.expectedSha,
        "request.candidate.expectedSha",
      ),
      admissionRoot: root(
        value.candidate.admissionRoot,
        "request.candidate.admissionRoot",
      ),
      reviewPullRequest: positiveInteger(
        value.candidate.reviewPullRequest,
        "request.candidate.reviewPullRequest",
      ),
    },
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

export function v4UniversalWorkflowRequestRoot(value) {
  return documentRoot(
    "universal-workflow-request",
    validateV4UniversalWorkflowRequest(value),
  );
}

function validatePolicy(value) {
  exactKeys(
    value,
    [
      "schema",
      "sourceRepository",
      "allowedConsumers",
      "allowedCapabilities",
      "permissionCeiling",
      "contractRoots",
      "targetRef",
      "allowedReviewers",
      "minimumApprovals",
      "requiredChecks",
      "validFrom",
      "expiresAt",
    ],
    "policy",
  );
  if (value.schema !== V4_UNIVERSAL_WORKFLOW_ADMISSION_POLICY)
    fail("unsupported-policy-schema", "policy schema is unsupported");
  const allowedConsumers = [...value.allowedConsumers].map((entry, index) =>
    repository(entry, `policy.allowedConsumers[${index}]`),
  );
  const expectedConsumers = [...new Set(allowedConsumers)].sort();
  if (
    allowedConsumers.length !== expectedConsumers.length ||
    allowedConsumers.some((entry, index) => entry !== expectedConsumers[index])
  )
    fail(
      "non-canonical-consumers",
      "policy.allowedConsumers must be sorted and duplicate-free",
    );
  const policy = {
    schema: value.schema,
    sourceRepository: repository(
      value.sourceRepository,
      "policy.sourceRepository",
    ),
    allowedConsumers,
    allowedCapabilities: sortedTokens(
      value.allowedCapabilities,
      "policy.allowedCapabilities",
    ),
    permissionCeiling: permissions(
      value.permissionCeiling,
      "policy.permissionCeiling",
    ),
    contractRoots: sortedRoots(value.contractRoots, "policy.contractRoots"),
    targetRef: nonEmpty(value.targetRef, "policy.targetRef"),
    allowedReviewers: sortedTokens(
      value.allowedReviewers,
      "policy.allowedReviewers",
    ),
    minimumApprovals: positiveInteger(
      value.minimumApprovals,
      "policy.minimumApprovals",
    ),
    requiredChecks: sortedStrings(
      value.requiredChecks,
      "policy.requiredChecks",
    ),
    validFrom: timestamp(value.validFrom, "policy.validFrom"),
    expiresAt: timestamp(value.expiresAt, "policy.expiresAt"),
  };
  if (Date.parse(policy.validFrom) >= Date.parse(policy.expiresAt))
    fail("invalid-policy-window", "policy validity window is empty");
  return policy;
}

function validateReviewEvidence(value) {
  exactKeys(
    value,
    [
      "repository",
      "pullRequest",
      "headSha",
      "baseRef",
      "approvals",
      "checks",
      "observedAt",
    ],
    "reviewEvidence",
  );
  const approvals = value.approvals.map((approval, index) => {
    exactKeys(
      approval,
      ["reviewer", "commitSha", "submittedAt"],
      `reviewEvidence.approvals[${index}]`,
    );
    return {
      reviewer: nonEmpty(
        approval.reviewer,
        `reviewEvidence.approvals[${index}].reviewer`,
      ),
      commitSha: exactSha(
        approval.commitSha,
        `reviewEvidence.approvals[${index}].commitSha`,
      ),
      submittedAt: timestamp(
        approval.submittedAt,
        `reviewEvidence.approvals[${index}].submittedAt`,
      ),
    };
  });
  const checks = value.checks.map((check, index) => {
    exactKeys(
      check,
      ["name", "status", "conclusion"],
      `reviewEvidence.checks[${index}]`,
    );
    return {
      name: nonEmpty(check.name, `reviewEvidence.checks[${index}].name`),
      status: nonEmpty(check.status, `reviewEvidence.checks[${index}].status`),
      conclusion: nonEmpty(
        check.conclusion,
        `reviewEvidence.checks[${index}].conclusion`,
      ),
    };
  });
  return {
    repository: repository(value.repository, "reviewEvidence.repository"),
    pullRequest: positiveInteger(
      value.pullRequest,
      "reviewEvidence.pullRequest",
    ),
    headSha: exactSha(value.headSha, "reviewEvidence.headSha"),
    baseRef: nonEmpty(value.baseRef, "reviewEvidence.baseRef"),
    approvals,
    checks,
    observedAt: timestamp(value.observedAt, "reviewEvidence.observedAt"),
  };
}

export function v4UniversalWorkflowAdmissionRoot(value) {
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

export function admitV4UniversalWorkflow({
  request: requestValue,
  policy: policyValue,
  observedRefSha,
  observedConsumerRepository,
  observedConsumerSha,
  reviewEvidence: reviewEvidenceValue,
  now,
} = {}) {
  const request = validateV4UniversalWorkflowRequest(requestValue);
  const policy = validatePolicy(policyValue);
  const admissionRoot = v4UniversalWorkflowAdmissionRoot(policy);
  if (request.candidate.admissionRoot !== admissionRoot)
    fail("stale-admission", "request is not bound to the current admission");
  if (policy.sourceRepository !== request.candidate.repository)
    fail("source-repository-mismatch", "admission source repository mismatch");
  if (!policy.allowedConsumers.includes(request.consumer.repository))
    fail("consumer-not-admitted", "consumer repository is not admitted");
  if (
    request.consumer.repository !== observedConsumerRepository ||
    request.consumer.sourceSha !== exactSha(observedConsumerSha, "observedConsumerSha")
  )
    fail("consumer-identity-mismatch", "request does not bind the caller repository and SHA");
  if (!policy.allowedCapabilities.includes(request.capability.id))
    fail("capability-not-admitted", "capability is not admitted");
  if (
    request.capability.contractRoots.length !== policy.contractRoots.length ||
    request.capability.contractRoots.some(
      (value, index) => value !== policy.contractRoots[index],
    )
  )
    fail("contract-root-mismatch", "candidate contract roots are not admitted");
  assertPermissionCeiling(
    request.capability.permissions,
    policy.permissionCeiling,
  );
  const observedAt = timestamp(now, "now");
  if (
    Date.parse(observedAt) < Date.parse(policy.validFrom) ||
    Date.parse(observedAt) >= Date.parse(policy.expiresAt)
  )
    fail("stale-admission", "admission is outside its validity window");
  const runtimeSha = exactSha(observedRefSha, "observedRefSha");
  if (runtimeSha !== request.candidate.expectedSha)
    fail(
      "candidate-ref-moved",
      "candidate ref readback does not match expected SHA",
    );
  const reviewEvidence = validateReviewEvidence(reviewEvidenceValue);
  if (
    reviewEvidence.repository !== request.candidate.repository ||
    reviewEvidence.pullRequest !== request.candidate.reviewPullRequest ||
    reviewEvidence.headSha !== runtimeSha ||
    reviewEvidence.baseRef !== policy.targetRef
  )
    fail(
      "review-identity-mismatch",
      "review evidence does not bind the candidate",
    );
  const approvedReviewers = new Set(
    reviewEvidence.approvals
      .filter((approval) => approval.commitSha === runtimeSha)
      .map((approval) => approval.reviewer),
  );
  const admittedApprovalCount = policy.allowedReviewers.filter((reviewer) =>
    approvedReviewers.has(reviewer),
  ).length;
  if (admittedApprovalCount < policy.minimumApprovals)
    fail(
      "independent-review-missing",
      "candidate lacks exact-head independent review",
    );
  const checksByName = new Map();
  for (const check of reviewEvidence.checks) {
    const entries = checksByName.get(check.name) || [];
    entries.push(check);
    checksByName.set(check.name, entries);
  }
  if (
    policy.requiredChecks.some((name) => {
      const checks = checksByName.get(name) || [];
      return (
        checks.length === 0 ||
        checks.some(
          (check) =>
            check.status !== "completed" || check.conclusion !== "success",
        )
      );
    })
  )
    fail(
      "exact-head-checks-incomplete",
      "candidate exact-head checks are not successful",
    );
  const requestRoot = v4UniversalWorkflowRequestRoot(request);
  const discovery = {
    repository: request.candidate.repository,
    ref: request.candidate.discoveryRef,
    expectedSha: request.candidate.expectedSha,
    observedSha: runtimeSha,
    observedAt,
  };
  return {
    schema: V4_UNIVERSAL_WORKFLOW_ADMISSION,
    status: "admitted",
    requestRoot,
    admissionRoot,
    discoveryRoot: documentRoot("universal-workflow-discovery", discovery),
    reviewRoot: documentRoot("universal-workflow-review", reviewEvidence),
    consumerRoot: documentRoot("universal-workflow-consumer", request.consumer),
    capabilityRoot: documentRoot(
      "universal-workflow-capability",
      request.capability,
    ),
    runtime: {
      repository: request.candidate.repository,
      sha: runtimeSha,
    },
    permissions: request.capability.permissions,
    contractRoots: request.capability.contractRoots,
  };
}

export function completeV4UniversalWorkflow({ admission, resultRoot, status }) {
  exactKeys(
    admission,
    [
      "schema",
      "status",
      "requestRoot",
      "admissionRoot",
      "discoveryRoot",
      "reviewRoot",
      "consumerRoot",
      "capabilityRoot",
      "runtime",
      "permissions",
      "contractRoots",
    ],
    "admission",
  );
  if (
    admission.schema !== V4_UNIVERSAL_WORKFLOW_ADMISSION ||
    admission.status !== "admitted"
  )
    fail("invalid-admission", "terminal receipt requires an admitted request");
  if (!new Set(["succeeded", "failed", "cancelled"]).has(status))
    fail("invalid-terminal-status", "terminal status is unsupported");
  const receipt = {
    schema: V4_UNIVERSAL_WORKFLOW_TERMINAL_RECEIPT,
    status,
    requestRoot: root(admission.requestRoot, "admission.requestRoot"),
    admissionRoot: root(admission.admissionRoot, "admission.admissionRoot"),
    discoveryRoot: root(admission.discoveryRoot, "admission.discoveryRoot"),
    reviewRoot: root(admission.reviewRoot, "admission.reviewRoot"),
    consumerRoot: root(admission.consumerRoot, "admission.consumerRoot"),
    capabilityRoot: root(admission.capabilityRoot, "admission.capabilityRoot"),
    runtime: {
      repository: repository(
        admission.runtime?.repository,
        "admission.runtime.repository",
      ),
      sha: exactSha(admission.runtime?.sha, "admission.runtime.sha"),
    },
    resultRoot: root(resultRoot, "resultRoot"),
  };
  return {
    ...receipt,
    receiptRoot: documentRoot("universal-workflow-receipt", receipt),
  };
}
