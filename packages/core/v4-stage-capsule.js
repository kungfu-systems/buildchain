import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_STAGE_CAPSULE_CONTRACT = "buildchain-v4-stage-capsule/v1";
export const V4_STAGE_CAPSULE_IDENTITY_CONTRACT =
  "buildchain-v4-stage-capsule-identity/v1";
export const V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT =
  "buildchain-v4-stage-capsule-availability/v1";
export const V4_STAGE_CAPSULE_REUSE_CONTRACT =
  "buildchain-v4-stage-capsule-reuse/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const AVAILABILITY = new Set([
  "available",
  "missing",
  "expired",
  "corrupt",
  "root-mismatch",
]);

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-stage-capsule-shape", path, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "invalid-stage-capsule-shape",
      path,
      `${path} keys are not canonical`,
    );
}

function validateToken(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stage-capsule-token",
      path,
      `${path} must be an ASCII token`,
    );
}

function validateNamedRoots(value, path) {
  if (!Array.isArray(value))
    fault("invalid-stage-capsule-shape", path, `${path} must be an array`);
  let prior = null;
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}/${index}`;
    exactKeys(entry, ["name", "root"], entryPath);
    validateToken(entry.name, `${entryPath}/name`);
    validateV4Root(entry.root, `${entryPath}/root`);
    if (prior !== null && entry.name <= prior)
      fault(
        "unordered-stage-capsule-roots",
        `${entryPath}/name`,
        `${path} names must be unique and byte-sorted`,
      );
    prior = entry.name;
  }
}

export function validateV4StageCapsuleIdentity(value) {
  exactKeys(
    value,
    [
      "schema",
      "sourceRoot",
      "platform",
      "platformRoot",
      "stage",
      "toolchainRoots",
      "runtimeRoot",
      "policyRoot",
      "declaredInputs",
      "transformationRoot",
      "outputManifestRoot",
      "qualificationRoot",
      "observationRoots",
    ],
    "$/identity",
  );
  if (value.schema !== V4_STAGE_CAPSULE_IDENTITY_CONTRACT)
    fault(
      "unsupported-stage-capsule-version",
      "$/identity/schema",
      "unsupported Stage Capsule identity schema",
    );
  for (const name of ["platform", "stage"])
    validateToken(value[name], `$/identity/${name}`);
  for (const name of [
    "sourceRoot",
    "platformRoot",
    "runtimeRoot",
    "policyRoot",
    "transformationRoot",
    "outputManifestRoot",
    "qualificationRoot",
  ])
    validateV4Root(value[name], `$/identity/${name}`);
  validateNamedRoots(value.toolchainRoots, "$/identity/toolchainRoots");
  validateNamedRoots(value.declaredInputs, "$/identity/declaredInputs");
  validateNamedRoots(value.observationRoots, "$/identity/observationRoots");
  return value;
}

export function v4StageCapsuleIdentityRoot(identity) {
  validateV4StageCapsuleIdentity(identity);
  return v4ContentRoot("stage-capsule-identity", identity);
}

function validateRetentionPromise(value) {
  exactKeys(value, ["class", "retainUntil"], "$/retentionPromise");
  validateToken(value.class, "$/retentionPromise/class");
  validateV4Clock(value.retainUntil, "$/retentionPromise/retainUntil");
}

function capsulePayload(value) {
  return {
    schema: value.schema,
    writerAuthority: value.writerAuthority,
    rustAuthority: value.rustAuthority,
    identity: value.identity,
    identityRoot: value.identityRoot,
    retentionPromise: value.retentionPromise,
  };
}

export function validateV4StageCapsule(value) {
  exactKeys(
    value,
    [
      "schema",
      "writerAuthority",
      "rustAuthority",
      "identity",
      "identityRoot",
      "retentionPromise",
      "capsuleRoot",
    ],
    "$",
  );
  if (value.schema !== V4_STAGE_CAPSULE_CONTRACT)
    fault(
      "unsupported-stage-capsule-version",
      "$/schema",
      "unsupported Stage Capsule schema",
    );
  if (
    value.writerAuthority !== "typescript-v3" ||
    value.rustAuthority !== "validation-only"
  )
    fault(
      "invalid-stage-capsule-authority",
      "$/writerAuthority",
      "Stage Capsule authority must remain TypeScript v3 with validation-only Rust",
    );
  const identityRoot = v4StageCapsuleIdentityRoot(value.identity);
  validateV4Root(value.identityRoot, "$/identityRoot");
  if (value.identityRoot !== identityRoot)
    fault(
      "stage-capsule-identity-root-mismatch",
      "$/identityRoot",
      "identityRoot does not bind the canonical Stage Capsule identity",
    );
  validateRetentionPromise(value.retentionPromise);
  validateV4Root(value.capsuleRoot, "$/capsuleRoot");
  const capsuleRoot = v4ContentRoot("stage-capsule", capsulePayload(value));
  if (value.capsuleRoot !== capsuleRoot)
    fault(
      "stage-capsule-root-mismatch",
      "$/capsuleRoot",
      "capsuleRoot does not bind the canonical Stage Capsule",
    );
  return value;
}

export function v4StageCapsuleRoot(value) {
  validateV4StageCapsuleIdentity(value.identity);
  validateRetentionPromise(value.retentionPromise);
  return v4ContentRoot("stage-capsule", capsulePayload(value));
}

export function validateV4StageCapsuleAvailability(value) {
  exactKeys(
    value,
    [
      "schema",
      "capsuleRoot",
      "observedAt",
      "status",
      "contentRoot",
      "qualificationRoot",
      "transports",
      "faultCode",
    ],
    "$/availability",
  );
  if (value.schema !== V4_STAGE_CAPSULE_AVAILABILITY_CONTRACT)
    fault(
      "unsupported-stage-capsule-version",
      "$/availability/schema",
      "unsupported Stage Capsule availability schema",
    );
  validateV4Root(value.capsuleRoot, "$/availability/capsuleRoot");
  validateV4Clock(value.observedAt, "$/availability/observedAt");
  if (!AVAILABILITY.has(value.status))
    fault(
      "invalid-stage-capsule-availability",
      "$/availability/status",
      "unsupported Stage Capsule availability status",
    );
  for (const name of ["contentRoot", "qualificationRoot"])
    if (value[name] !== null)
      validateV4Root(value[name], `$/availability/${name}`);
  validateNamedRoots(value.transports, "$/availability/transports");
  if (value.faultCode !== null)
    validateToken(value.faultCode, "$/availability/faultCode");
  if (
    value.status === "available" &&
    (value.contentRoot === null ||
      value.qualificationRoot === null ||
      value.faultCode !== null)
  )
    fault(
      "invalid-stage-capsule-availability",
      "$/availability",
      "available content requires content and qualification roots without a fault",
    );
  if (value.status !== "available" && value.faultCode === null)
    fault(
      "invalid-stage-capsule-availability",
      "$/availability/faultCode",
      "unavailable content requires a typed fault code",
    );
  return value;
}

export function v4StageCapsuleAvailabilityRoot(value) {
  validateV4StageCapsuleAvailability(value);
  return v4ContentRoot("stage-capsule-availability", value);
}

export function evaluateV4StageCapsuleReuse(request) {
  exactKeys(
    request,
    [
      "schema",
      "capsule",
      "availability",
      "evaluatedAt",
      "expectedCapsuleRoot",
      "expectedOutputManifestRoot",
      "expectedQualificationRoot",
    ],
    "$",
  );
  if (request.schema !== V4_STAGE_CAPSULE_REUSE_CONTRACT)
    fault(
      "unsupported-stage-capsule-version",
      "$/schema",
      "unsupported Stage Capsule reuse schema",
    );
  validateV4StageCapsule(request.capsule);
  validateV4StageCapsuleAvailability(request.availability);
  validateV4Clock(request.evaluatedAt, "$/evaluatedAt");
  for (const name of [
    "expectedCapsuleRoot",
    "expectedOutputManifestRoot",
    "expectedQualificationRoot",
  ])
    validateV4Root(request[name], `$/${name}`);
  const fail = (reason) => ({
    schema: V4_STAGE_CAPSULE_REUSE_CONTRACT,
    eligible: false,
    capsuleRoot: request.capsule.capsuleRoot,
    availabilityRoot: v4StageCapsuleAvailabilityRoot(request.availability),
    reason,
  });
  if (
    request.expectedCapsuleRoot !== request.capsule.capsuleRoot ||
    request.availability.capsuleRoot !== request.capsule.capsuleRoot
  )
    return fail("root-mismatch");
  if (request.availability.status !== "available")
    return fail(request.availability.status);
  if (request.evaluatedAt > request.capsule.retentionPromise.retainUntil)
    return fail("expired");
  if (
    request.expectedOutputManifestRoot !==
      request.capsule.identity.outputManifestRoot ||
    request.availability.contentRoot !==
      request.capsule.identity.outputManifestRoot ||
    request.expectedQualificationRoot !==
      request.capsule.identity.qualificationRoot ||
    request.availability.qualificationRoot !==
      request.capsule.identity.qualificationRoot
  )
    return fail("root-mismatch");
  return {
    schema: V4_STAGE_CAPSULE_REUSE_CONTRACT,
    eligible: true,
    capsuleRoot: request.capsule.capsuleRoot,
    availabilityRoot: v4StageCapsuleAvailabilityRoot(request.availability),
    reason: "eligible",
  };
}
