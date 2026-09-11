import crypto from "node:crypto";
export const RUNTIME_RESUME_LINEAGE_CONTRACT =
  "buildchain.runtime-resume-lineage/v2";
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;
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

export function runtimeResumeDocumentRoot(value) {
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

export function createRuntimeResumeLineage({
  repository,
  buildAttempt,
  resumeAttempt,
  source,
  consumerPolicyReceiptRoot,
  requiredPlatforms,
  stageCapsules,
  resumePlanRoot,
  finalPublicReadbackRoot,
} = {}) {
  const buildId = token(buildAttempt?.id, "buildAttempt.id");
  const resumeId = token(resumeAttempt?.id, "resumeAttempt.id");
  if (buildId === resumeId) {
    throw new Error("resume must create a new governed attempt");
  }
  const buildRuntimeSha = buildAttempt?.runtimeSha;
  const resumeRuntimeSha = resumeAttempt?.runtimeSha;
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
      root(capsule.policyRoot, `${platform}.policyRoot`) !== policyRoot
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
  const reusedCapsules = platforms
    .filter((platform) => capsuleByPlatform.has(platform))
    .map((platform) => capsuleByPlatform.get(platform));
  const rebuildPlatforms = platforms.filter(
    (platform) => !capsuleByPlatform.has(platform),
  );
  const lineage = {
    schemaVersion: 2,
    contract: RUNTIME_RESUME_LINEAGE_CONTRACT,
    status: "qualified",
    repository: nonEmpty(repository, "repository"),
    source: sourceIdentity,
    consumerPolicyReceiptRoot: policyRoot,
    attempts: {
      build: { id: buildId, runtimeSha: buildRuntimeSha },
      resume: { id: resumeId, runtimeSha: resumeRuntimeSha },
    },

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
  return { lineage, lineageRoot: runtimeResumeDocumentRoot(lineage) };
}

function validSourceIdentity(source) {
  return (
    EXACT_SHA.test(String(source?.sha || "")) &&
    EXACT_SHA.test(String(source?.treeSha || ""))
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

export function verifyRuntimeResumeLineage({
  lineage,
  lineageRoot,
  repository = "",
  sourceSha = "",
  consumerPolicyReceiptRoot = "",
} = {}) {
  const failures = [];
  const check = (condition, code) => {
    if (!condition) failures.push(code);
  };
  check(
    lineage?.contract === RUNTIME_RESUME_LINEAGE_CONTRACT,
    "contract-invalid",
  );
  check(lineage?.status === "qualified", "status-not-qualified");
  check(
    SHA256_ROOT.test(String(lineageRoot || "")) &&
      lineageRoot === runtimeResumeDocumentRoot(lineage),
    "lineage-root-mismatch",
  );
  check(
    lineage?.attempts?.build?.id &&
      lineage?.attempts?.resume?.id &&
      lineage.attempts.build.id !== lineage.attempts.resume.id,
    "attempt-not-fresh",
  );
  check(validSourceIdentity(lineage?.source), "source-identity-invalid");
  check(
    lineage?.continuation?.mechanism === "new-governed-attempt" &&
      lineage?.continuation?.rerunFailedJobs === false,
    "continuation-mechanism-invalid",
  );
  failures.push(...platformLineageFailures(lineage?.stageCapsules));
  check(
    [
      lineage?.consumerPolicyReceiptRoot,
      lineage?.continuation?.resumePlanRoot,
      lineage?.finalPublicReadbackRoot,
    ].every((value) => SHA256_ROOT.test(String(value || ""))),
    "evidence-root-invalid",
  );
  if (sourceSha)
    check(lineage?.source?.sha === sourceSha, "source-sha-mismatch");
  if (consumerPolicyReceiptRoot) {
    check(
      lineage?.consumerPolicyReceiptRoot === consumerPolicyReceiptRoot,
      "consumer-policy-root-mismatch",
    );
  }
  if (repository) {
    check(lineage?.repository === repository, "repository-mismatch");
  }
  return { ok: failures.length === 0, failures };
}
