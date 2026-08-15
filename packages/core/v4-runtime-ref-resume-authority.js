import crypto from "node:crypto";
import {
  V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT,
  scanV4RuntimeSelectorPersistence,
} from "./v4-runtime-selector-persistence.js";

export {
  V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT,
  scanV4RuntimeSelectorPersistence,
};

export const V4_RUNTIME_AUTHORIZATION_CONTRACT =
  "kungfu-buildchain-v4-runtime-authorization/v1";
export const V4_RUNTIME_RESUME_LINEAGE_CONTRACT =
  "kungfu-buildchain-v4-runtime-resume-lineage/v1";
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
const OFFICIAL_V4_REF = /^v4(?:-alpha)?$/u;
const TRAIN_V4_REF = /^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;
const AUTHORITY_V4_REF = /^authority\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function v4RuntimeResumeDocumentRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!EXACT_SHA.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return normalized;
}

function root(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!SHA256_ROOT.test(normalized)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return normalized;
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function token(value, label) {
  const normalized = nonEmpty(value, label);
  if (!TOKEN.test(normalized)) {
    throw new Error(`${label} must be an ASCII identity token`);
  }
  return normalized;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  const normalized = values.map((value, index) =>
    token(value, `${label}[${index}]`),
  );
  const expected = [...new Set(normalized)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  if (
    normalized.length !== expected.length ||
    normalized.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`${label} must be byte-sorted and duplicate-free`);
  }
  return normalized;
}

function normalizeRef(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/(?:heads|tags)\//u, "");
}

function approvedV4Ref(value) {
  const ref = normalizeRef(value);
  return (
    OFFICIAL_V4_REF.test(ref) ||
    TRAIN_V4_REF.test(ref) ||
    AUTHORITY_V4_REF.test(ref)
  );
}

function runtimeClass(value) {
  const ref = normalizeRef(value);
  if (EXACT_SHA.test(ref.toLowerCase())) return "exact-sha";
  if (OFFICIAL_V4_REF.test(ref)) return "floating";
  if (TRAIN_V4_REF.test(ref)) return "train";
  if (AUTHORITY_V4_REF.test(ref)) return "authority";
  return "rejected";
}

function normalizeReadbacks(values, runtimeSha) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      "approvedRefReadbacks must contain provider readback evidence",
    );
  }
  const normalized = values.map((value, index) => {
    exactKeys(
      value,
      ["ref", "sha", "containsRuntimeSha", "readbackRoot"],
      `approvedRefReadbacks[${index}]`,
    );
    const ref = normalizeRef(value.ref);
    if (!approvedV4Ref(ref)) {
      throw new Error(
        `approvedRefReadbacks[${index}].ref is not an approved v4 ref`,
      );
    }
    return {
      ref,
      sha: exactSha(value.sha, `approvedRefReadbacks[${index}].sha`),
      containsRuntimeSha: value.containsRuntimeSha === true,
      readbackRoot: root(
        value.readbackRoot,
        `approvedRefReadbacks[${index}].readbackRoot`,
      ),
    };
  });
  normalized.sort((left, right) =>
    Buffer.from(left.ref).compare(Buffer.from(right.ref)),
  );
  if (
    new Set(normalized.map((entry) => entry.ref)).size !== normalized.length
  ) {
    throw new Error("approvedRefReadbacks refs must be unique");
  }
  if (!normalized.some((entry) => entry.containsRuntimeSha)) {
    throw new Error(
      `runtime ${runtimeSha} is not reachable from an approved v4 ref`,
    );
  }
  return normalized;
}

export function authorizeV4RuntimeSelection({
  repository,
  eventName,
  mode = "dispatch",
  actor,
  actorPermission,
  reason,
  authorizedAt,
  sourceSha,
  sourceTreeSha,
  requestedRef,
  resolvedRuntimeSha,
  approvedRefReadbacks,
  stableContractLockRoot,
  alphaContractLockRoot,
  consumerPolicyReceiptRoot,
  persistenceScan,
} = {}) {
  const runtimeSha = exactSha(resolvedRuntimeSha, "resolvedRuntimeSha");
  const ref = normalizeRef(requestedRef);
  const refClass = runtimeClass(ref);
  if (refClass === "rejected")
    throw new Error(
      "requestedRef is outside the v4 runtime authority boundary",
    );
  if (!new Set(["dispatch", "resume", "rescue"]).has(mode)) {
    throw new Error("mode must be dispatch, resume, or rescue");
  }
  if (eventName !== "workflow_dispatch") {
    throw new Error(
      "v4 runtime escape is only allowed for trusted workflow_dispatch runs",
    );
  }
  if (!new Set(["write", "maintain", "admin"]).has(actorPermission)) {
    throw new Error(
      "v4 runtime escape requires write, maintain, or admin permission",
    );
  }
  if (
    !persistenceScan ||
    persistenceScan.contract !== V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT
  ) {
    throw new Error("a v4 runtime persistence scan is required");
  }
  if (persistenceScan.status !== "passed" || persistenceScan.failures?.length) {
    throw new Error(
      "runtime selector persistence scan must pass before authorization",
    );
  }
  const scanPayload = { ...persistenceScan };
  delete scanPayload.root;
  if (persistenceScan.root !== v4RuntimeResumeDocumentRoot(scanPayload)) {
    throw new Error("runtime persistence scan root mismatch");
  }
  const readbacks = normalizeReadbacks(approvedRefReadbacks, runtimeSha);
  if (refClass !== "exact-sha") {
    const direct = readbacks.find((entry) => entry.ref === ref);
    if (!direct || direct.sha !== runtimeSha) {
      throw new Error(
        "named runtime ref readback does not match resolvedRuntimeSha",
      );
    }
  }
  const timestamp = nonEmpty(authorizedAt, "authorizedAt");
  if (Number.isNaN(Date.parse(timestamp)))
    throw new Error("authorizedAt must be an ISO-8601 timestamp");
  const receipt = {
    schemaVersion: 1,
    contract: V4_RUNTIME_AUTHORIZATION_CONTRACT,
    status: "authorized",
    mode,
    eventName,
    repository: nonEmpty(repository, "repository"),
    actor: {
      login: nonEmpty(actor, "actor"),
      permission: actorPermission,
    },
    reason: nonEmpty(reason, "reason"),
    authorizedAt: timestamp,
    source: {
      sha: exactSha(sourceSha, "sourceSha"),
      treeSha: exactSha(sourceTreeSha, "sourceTreeSha"),
    },
    request: { ref, class: refClass },
    runtime: { sha: runtimeSha, reachableFrom: readbacks },
    contractLocks: {
      stableRoot: root(stableContractLockRoot, "stableContractLockRoot"),
      alphaRoot: root(alphaContractLockRoot, "alphaContractLockRoot"),
    },
    consumerPolicyReceiptRoot: root(
      consumerPolicyReceiptRoot,
      "consumerPolicyReceiptRoot",
    ),
    persistenceScanRoot: root(persistenceScan.root, "persistenceScan.root"),
  };
  return { receipt, receiptRoot: v4RuntimeResumeDocumentRoot(receipt) };
}

export function verifyV4RuntimeAuthorizationReceipt({
  receipt,
  receiptRoot,
  repository = "",
  sourceSha = "",
  runtimeSha = "",
  consumerPolicyReceiptRoot = "",
} = {}) {
  const failures = [];
  const check = (condition, code) => {
    if (!condition) failures.push(code);
  };
  check(
    receipt?.contract === V4_RUNTIME_AUTHORIZATION_CONTRACT,
    "contract-invalid",
  );
  check(receipt?.status === "authorized", "status-not-authorized");
  check(
    SHA256_ROOT.test(String(receiptRoot || "")) &&
      receiptRoot === v4RuntimeResumeDocumentRoot(receipt),
    "receipt-root-mismatch",
  );
  check(receipt?.eventName === "workflow_dispatch", "event-not-trusted");
  check(
    new Set(["write", "maintain", "admin"]).has(receipt?.actor?.permission),
    "permission-insufficient",
  );
  check(
    EXACT_SHA.test(String(receipt?.runtime?.sha || "")),
    "runtime-sha-invalid",
  );
  check(
    Array.isArray(receipt?.runtime?.reachableFrom) &&
      receipt.runtime.reachableFrom.some(
        (entry) =>
          approvedV4Ref(entry.ref) && entry.containsRuntimeSha === true,
      ),
    "runtime-unreachable",
  );
  if (repository)
    check(receipt?.repository === repository, "repository-mismatch");
  if (sourceSha)
    check(receipt?.source?.sha === sourceSha, "source-sha-mismatch");
  if (runtimeSha)
    check(receipt?.runtime?.sha === runtimeSha, "runtime-sha-mismatch");
  if (consumerPolicyReceiptRoot) {
    check(
      receipt?.consumerPolicyReceiptRoot === consumerPolicyReceiptRoot,
      "consumer-policy-root-mismatch",
    );
  }
  return { ok: failures.length === 0, failures };
}

export function createV4RuntimeResumeLineage({
  authorization,
  authorizationRoot,
  buildAttempt,
  resumeAttempt,
  source,
  consumerPolicyReceiptRoot,
  requiredPlatforms,
  stageCapsules,
  resumePlanRoot,
  finalPublicReadbackRoot,
  floatingRefBefore,
  floatingRefAfter,
} = {}) {
  const verification = verifyV4RuntimeAuthorizationReceipt({
    receipt: authorization,
    receiptRoot: authorizationRoot,
    sourceSha: source?.sha,
    runtimeSha: resumeAttempt?.runtimeSha,
    consumerPolicyReceiptRoot,
  });
  if (!verification.ok) {
    throw new Error(
      `runtime authorization invalid: ${verification.failures.join(", ")}`,
    );
  }
  const buildId = token(buildAttempt?.id, "buildAttempt.id");
  const resumeId = token(resumeAttempt?.id, "resumeAttempt.id");
  if (buildId === resumeId) {
    throw new Error("resume must create a new governed attempt");
  }
  const buildRuntimeSha = exactSha(
    buildAttempt?.runtimeSha,
    "buildAttempt.runtimeSha",
  );
  const resumeRuntimeSha = exactSha(
    resumeAttempt?.runtimeSha,
    "resumeAttempt.runtimeSha",
  );
  if (buildRuntimeSha === resumeRuntimeSha) {
    throw new Error(
      "resume runtime must differ from the original build runtime",
    );
  }
  const sourceIdentity = {
    sha: exactSha(source?.sha, "source.sha"),
    treeSha: exactSha(source?.treeSha, "source.treeSha"),
  };
  const policyRoot = root(
    consumerPolicyReceiptRoot,
    "consumerPolicyReceiptRoot",
  );
  const platforms = sortedUnique(requiredPlatforms, "requiredPlatforms");
  if (!Array.isArray(stageCapsules))
    throw new Error("stageCapsules must be an array");
  const capsuleByPlatform = new Map();
  for (const [index, capsule] of stageCapsules.entries()) {
    exactKeys(
      capsule,
      [
        "platform",
        "capsuleRoot",
        "identityRoot",
        "artifactDigest",
        "sourceSha",
        "sourceTreeSha",
        "policyRoot",
        "buildRuntimeSha",
        "sealed",
      ],
      `stageCapsules[${index}]`,
    );
    const platform = token(
      capsule.platform,
      `stageCapsules[${index}].platform`,
    );
    if (!platforms.includes(platform)) {
      throw new Error(`stageCapsules[${index}] names an undeclared platform`);
    }
    if (capsuleByPlatform.has(platform)) {
      throw new Error(`duplicate Stage Capsule for ${platform}`);
    }
    if (capsule.sealed !== true)
      throw new Error(`Stage Capsule ${platform} is not sealed`);
    if (
      exactSha(capsule.sourceSha, `${platform}.sourceSha`) !==
        sourceIdentity.sha ||
      exactSha(capsule.sourceTreeSha, `${platform}.sourceTreeSha`) !==
        sourceIdentity.treeSha ||
      root(capsule.policyRoot, `${platform}.policyRoot`) !== policyRoot ||
      exactSha(capsule.buildRuntimeSha, `${platform}.buildRuntimeSha`) !==
        buildRuntimeSha
    ) {
      throw new Error(
        `Stage Capsule ${platform} identity is stale or ambiguous`,
      );
    }
    capsuleByPlatform.set(platform, {
      platform,
      capsuleRoot: root(capsule.capsuleRoot, `${platform}.capsuleRoot`),
      identityRoot: root(capsule.identityRoot, `${platform}.identityRoot`),
      artifactDigest: root(
        capsule.artifactDigest,
        `${platform}.artifactDigest`,
      ),
    });
  }
  const before = {
    ref: normalizeRef(floatingRefBefore?.ref),
    sha: exactSha(floatingRefBefore?.sha, "floatingRefBefore.sha"),
  };
  const after = {
    ref: normalizeRef(floatingRefAfter?.ref),
    sha: exactSha(floatingRefAfter?.sha, "floatingRefAfter.sha"),
  };
  if (!OFFICIAL_V4_REF.test(before.ref) || before.ref !== after.ref) {
    throw new Error(
      "floating ref movement must remain on one official v4 channel",
    );
  }
  if (before.sha === after.sha) {
    throw new Error(
      "floating ref movement must bind distinct before and after SHAs",
    );
  }
  const reusedCapsules = platforms
    .filter((platform) => capsuleByPlatform.has(platform))
    .map((platform) => capsuleByPlatform.get(platform));
  const rebuildPlatforms = platforms.filter(
    (platform) => !capsuleByPlatform.has(platform),
  );
  const lineage = {
    schemaVersion: 1,
    contract: V4_RUNTIME_RESUME_LINEAGE_CONTRACT,
    status: "qualified",
    authorizationRoot: root(authorizationRoot, "authorizationRoot"),
    source: sourceIdentity,
    consumerPolicyReceiptRoot: policyRoot,
    attempts: {
      build: { id: buildId, runtimeSha: buildRuntimeSha },
      resume: { id: resumeId, runtimeSha: resumeRuntimeSha },
    },
    floatingRefMovement: { before, after },
    continuation: {
      mechanism: "new-governed-attempt",
      rerunFailedJobs: false,
      resumePlanRoot: root(resumePlanRoot, "resumePlanRoot"),
    },
    stageCapsules: {
      requiredPlatforms: platforms,
      reused: reusedCapsules,
      rebuildPlatforms,
    },
    finalPublicReadbackRoot: root(
      finalPublicReadbackRoot,
      "finalPublicReadbackRoot",
    ),
  };
  return { lineage, lineageRoot: v4RuntimeResumeDocumentRoot(lineage) };
}

function validSourceIdentity(source) {
  return (
    EXACT_SHA.test(String(source?.sha || "")) &&
    EXACT_SHA.test(String(source?.treeSha || ""))
  );
}

function validRuntimeTransition(attempts) {
  return (
    EXACT_SHA.test(String(attempts?.build?.runtimeSha || "")) &&
    EXACT_SHA.test(String(attempts?.resume?.runtimeSha || "")) &&
    attempts.build.runtimeSha !== attempts.resume.runtimeSha
  );
}

function validFloatingRefMovement(movement) {
  return (
    OFFICIAL_V4_REF.test(String(movement?.before?.ref || "")) &&
    movement.before.ref === movement?.after?.ref &&
    EXACT_SHA.test(String(movement.before.sha || "")) &&
    EXACT_SHA.test(String(movement.after.sha || "")) &&
    movement.before.sha !== movement.after.sha
  );
}

function platformLineageFailures(stageCapsules) {
  const failures = [];
  const required = stageCapsules?.requiredPlatforms || [];
  const reused = stageCapsules?.reused || [];
  const rebuilt = stageCapsules?.rebuildPlatforms || [];
  const requiredCanonical = [...new Set(required)].sort();
  const reusedPlatforms = reused.map((entry) => entry.platform);
  const rebuiltCanonical = [...new Set(rebuilt)].sort();
  if (
    required.length === 0 ||
    required.length !== requiredCanonical.length ||
    !required.every((platform, index) => platform === requiredCanonical[index])
  ) {
    failures.push("required-platforms-invalid");
  }
  if (
    reusedPlatforms.length !== new Set(reusedPlatforms).size ||
    rebuilt.length !== rebuiltCanonical.length ||
    !reusedPlatforms.every((platform) => !rebuilt.includes(platform))
  ) {
    failures.push("platform-lineage-ambiguous");
  }
  if (
    [...reusedPlatforms, ...rebuilt].sort().join("\0") !==
    [...required].sort().join("\0")
  ) {
    failures.push("platform-lineage-incomplete");
  }
  if (
    !reused.every((entry) =>
      [entry.capsuleRoot, entry.identityRoot, entry.artifactDigest].every(
        (value) => SHA256_ROOT.test(String(value || "")),
      ),
    )
  ) {
    failures.push("capsule-root-invalid");
  }
  return failures;
}

export function verifyV4RuntimeResumeLineage({
  lineage,
  lineageRoot,
  repository = "",
  sourceSha = "",
  buildRuntimeSha = "",
  resumeRuntimeSha = "",
  consumerPolicyReceiptRoot = "",
} = {}) {
  const failures = [];
  const check = (condition, code) => {
    if (!condition) failures.push(code);
  };
  check(
    lineage?.contract === V4_RUNTIME_RESUME_LINEAGE_CONTRACT,
    "contract-invalid",
  );
  check(lineage?.status === "qualified", "status-not-qualified");
  check(
    SHA256_ROOT.test(String(lineageRoot || "")) &&
      lineageRoot === v4RuntimeResumeDocumentRoot(lineage),
    "lineage-root-mismatch",
  );
  check(
    lineage?.attempts?.build?.id &&
      lineage?.attempts?.resume?.id &&
      lineage.attempts.build.id !== lineage.attempts.resume.id,
    "attempt-not-fresh",
  );
  check(validSourceIdentity(lineage?.source), "source-identity-invalid");
  check(validRuntimeTransition(lineage?.attempts), "runtime-lineage-invalid");
  check(
    validFloatingRefMovement(lineage?.floatingRefMovement),
    "floating-ref-movement-invalid",
  );
  check(
    lineage?.continuation?.mechanism === "new-governed-attempt" &&
      lineage?.continuation?.rerunFailedJobs === false,
    "continuation-mechanism-invalid",
  );
  failures.push(...platformLineageFailures(lineage?.stageCapsules));
  check(
    [
      lineage?.authorizationRoot,
      lineage?.consumerPolicyReceiptRoot,
      lineage?.continuation?.resumePlanRoot,
      lineage?.finalPublicReadbackRoot,
    ].every((value) => SHA256_ROOT.test(String(value || ""))),
    "evidence-root-invalid",
  );
  if (sourceSha)
    check(lineage?.source?.sha === sourceSha, "source-sha-mismatch");
  if (buildRuntimeSha) {
    check(
      lineage?.attempts?.build?.runtimeSha === buildRuntimeSha,
      "build-runtime-mismatch",
    );
  }
  if (resumeRuntimeSha) {
    check(
      lineage?.attempts?.resume?.runtimeSha === resumeRuntimeSha,
      "resume-runtime-mismatch",
    );
  }
  if (consumerPolicyReceiptRoot) {
    check(
      lineage?.consumerPolicyReceiptRoot === consumerPolicyReceiptRoot,
      "consumer-policy-root-mismatch",
    );
  }
  if (repository) {
    check(Boolean(lineage?.authorizationRoot), "authorization-root-missing");
  }
  return { ok: failures.length === 0, failures };
}
