import { v4ContentRoot, validateV4Root } from "./v4-canonical-contracts.js";
import { validateReleaseCandidatePassport } from "./release-candidate.js";
import {
  V4_TAIL_RESEAL_PLAN_CONTRACT,
  V4_TAIL_RESEAL_PLATFORMS,
  V4TailResealFault,
  normalizeV4TailResealRequest,
  planV4TailReseal,
} from "./v4-tail-reseal.js";

export const V4_TAIL_RESEAL_RECEIPT_CONTRACT =
  "kungfu-buildchain-v4-tail-reseal-receipt/v1";

function fault(code, path, message) {
  throw new V4TailResealFault(code, path, message);
}

function root(value, path) {
  try {
    validateV4Root(value, path);
  } catch (error) {
    fault("invalid-tail-reseal-root", path, error.message);
  }
  return value;
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-tail-reseal-shape", path, "object required");
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-tail-reseal-shape",
      path,
      "keys do not match the closed tail-reseal contract",
    );
}

function positiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1)
    fault(
      "invalid-tail-reseal-integer",
      path,
      "positive safe integer required",
    );
}

function validateReadbacks(readbacks, request) {
  if (
    !Array.isArray(readbacks) ||
    readbacks.length !== V4_TAIL_RESEAL_PLATFORMS.length
  )
    fault(
      "tail-reseal-readback-mismatch",
      "$/readbacks",
      "one readback per platform required",
    );
  const normalized = [...readbacks].sort((left, right) =>
    Buffer.from(left.platformId || "").compare(
      Buffer.from(right.platformId || ""),
    ),
  );
  for (const [index, readback] of normalized.entries()) {
    const path = `$/readbacks/${index}`;
    exactKeys(
      readback,
      [
        "platformId",
        "artifactRoot",
        "manifestRoot",
        "capsuleRoot",
        "byteIdentical",
        "providerReadbackRoot",
      ],
      path,
    );
    const expected = request.platforms[index];
    if (readback.platformId !== expected.id)
      fault(
        "tail-reseal-platform-mismatch",
        `${path}/platformId`,
        "unexpected platform readback",
      );
    for (const field of ["artifactRoot", "manifestRoot", "capsuleRoot"])
      root(readback[field], `${path}/${field}`);
    if (readback.capsuleRoot !== expected.capsuleRoot)
      fault(
        "tail-reseal-capsule-mismatch",
        `${path}/capsuleRoot`,
        "Stage Capsule identity changed during tail execution",
      );
    if (readback.platformId === "macos-arm64") {
      if (readback.byteIdentical !== false)
        fault(
          "tail-reseal-macos-effect-missing",
          `${path}/byteIdentical`,
          "macOS signed bytes must be independently resealed",
        );
      root(readback.providerReadbackRoot, `${path}/providerReadbackRoot`);
    } else if (
      readback.byteIdentical !== true ||
      readback.artifactRoot !== expected.artifactRoot ||
      readback.manifestRoot !== expected.manifestRoot ||
      readback.providerReadbackRoot !== null
    )
      fault(
        "tail-reseal-nontail-byte-drift",
        path,
        "non-macOS retained artifacts must remain byte-identical and effect-free",
      );
  }
  return normalized;
}

export function createV4TailResealReceipt({
  request,
  plan,
  readbacks,
  passport,
  protectedReadbackRoot,
  currentRun,
} = {}) {
  const normalized = normalizeV4TailResealRequest(request);
  const expectedPlan = planV4TailReseal(normalized);
  const { planRoot: _planRoot, ...planBody } = plan || {};
  if (
    plan?.schema !== V4_TAIL_RESEAL_PLAN_CONTRACT ||
    plan.planRoot !== expectedPlan.planRoot ||
    v4ContentRoot("tail-reseal-plan", planBody) !== expectedPlan.planRoot
  )
    fault(
      "tail-reseal-plan-drift",
      "$/plan",
      "plan does not match the exact request",
    );
  const platformReadbacks = validateReadbacks(readbacks, normalized);
  const passportValidation = validateReleaseCandidatePassport({
    passport,
    repository: normalized.repository,
    targetChannel: normalized.target.channel,
    version: normalized.target.version,
    sourceHeadSha: normalized.source.sha,
    requirePlatforms: true,
  });
  if (!passportValidation.ok)
    fault(
      "tail-reseal-passport-invalid",
      "$/passport",
      passportValidation.errors.join("; "),
    );
  if (
    passport.contract !== "kungfu-buildchain-release-candidate-passport" ||
    passport.buildchain?.sha !== normalized.runtime.sha ||
    passport.consumerPolicy?.receiptRoot !==
      normalized.runtime.consumerPolicyReceiptRoot
  )
    fault(
      "tail-reseal-passport-binding-mismatch",
      "$/passport",
      "standard v4 candidate Passport bindings drifted",
    );
  root(protectedReadbackRoot, "$/protectedReadbackRoot");
  exactKeys(currentRun, ["id", "attempt"], "$/currentRun");
  positiveInteger(currentRun.id, "$/currentRun/id");
  positiveInteger(currentRun.attempt, "$/currentRun/attempt");
  const payload = {
    schema: V4_TAIL_RESEAL_RECEIPT_CONTRACT,
    action: "reused-retained-tail",
    repository: normalized.repository,
    source: normalized.source,
    target: normalized.target,
    runtime: normalized.runtime,
    planRoot: expectedPlan.planRoot,
    warrant: normalized.warrant,
    retention: normalized.retention,
    originalFailure: normalized.failure,
    signingAuthority: normalized.signing,
    releaseTail: normalized.releaseTail,
    platformReadbacks,
    skippedStages: expectedPlan.skippedStages,
    rerunStages: expectedPlan.rerunStages,
    passport: {
      contract: passport.contract,
      candidateHash: passport.candidateHash,
      passportRoot: v4ContentRoot("release-candidate-passport", passport),
    },
    protectedReadbackRoot,
    currentRun,
  };
  return {
    ...payload,
    receiptRoot: v4ContentRoot("tail-reseal-receipt", payload),
  };
}

export function verifyV4TailResealReceipt({ receipt, request, passport } = {}) {
  try {
    const expected = createV4TailResealReceipt({
      request,
      plan: planV4TailReseal(request),
      readbacks: receipt.platformReadbacks,
      passport,
      protectedReadbackRoot: receipt.protectedReadbackRoot,
      currentRun: receipt.currentRun,
    });
    return {
      ok: expected.receiptRoot === receipt.receiptRoot,
      receiptRoot: expected.receiptRoot,
      failures:
        expected.receiptRoot === receipt.receiptRoot
          ? []
          : [{ code: "tail-reseal-receipt-root-mismatch" }],
    };
  } catch (error) {
    return {
      ok: false,
      receiptRoot: "",
      failures: [{ code: error.code || "tail-reseal-receipt-invalid" }],
    };
  }
}
