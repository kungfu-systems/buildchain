import crypto from "node:crypto";

export const RELEASE_ACTIVATION_CONTRACT =
  "kungfu-buildchain-release-activation-transaction/v1";
export const RELEASE_ACTIVATION_RECEIPT_SET_CONTRACT =
  "kungfu-buildchain-release-activation-receipt-set/v1";

export const RELEASE_ACTIVATION_PHASES = Object.freeze([
  "candidate-qualified",
  "artifacts-published",
  "passport-sealed",
  "site-published",
  "public-readback",
  "evidence-synthesized",
]);

const ROOT = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT_KINDS = Object.freeze([
  "artifact-publication",
  "release-passport",
  "site-publication",
  "public-readback",
  "product-qualification",
]);

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

export function releaseActivationRoot(value) {
  const copy = structuredClone(value);
  delete copy.transactionRoot;
  delete copy.receiptSetRoot;
  return `sha256:${crypto.createHash("sha256").update(stableJson(copy)).digest("hex")}`;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function exactRoot(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!ROOT.test(normalized))
    throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

function exactSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  return normalized;
}

function normalizeBindings(bindings = {}) {
  const version = requiredString(bindings.version, "bindings.version");
  const tag = requiredString(bindings.tag, "bindings.tag");
  if (tag !== `v${version}`)
    throw new Error("bindings.tag must exactly match bindings.version");
  const channel = requiredString(bindings.channel, "bindings.channel");
  if (!["alpha", "release"].includes(channel)) {
    throw new Error("bindings.channel must be alpha or release");
  }
  const environment = requiredString(
    bindings.environment,
    "bindings.environment",
  );
  if (!["shadow", "production"].includes(environment)) {
    throw new Error("bindings.environment must be shadow or production");
  }
  return {
    sourceSha: exactSha(bindings.sourceSha, "bindings.sourceSha"),
    siteSourceSha: exactSha(bindings.siteSourceSha, "bindings.siteSourceSha"),
    tag,
    channel,
    version,
    environment,
    artifactSetRoot: exactRoot(
      bindings.artifactSetRoot,
      "bindings.artifactSetRoot",
    ),
  };
}

function normalizeOwners(owners = {}) {
  return {
    product: requiredString(owners.product, "owners.product"),
    transaction: requiredString(owners.transaction, "owners.transaction"),
    site: requiredString(owners.site, "owners.site"),
  };
}

export function createReleaseActivationTransaction({
  transactionId,
  mode = "shadow",
  bindings,
  owners,
} = {}) {
  if (!["shadow", "activation"].includes(mode)) {
    throw new Error("mode must be shadow or activation");
  }
  const normalizedBindings = normalizeBindings(bindings);
  if (mode === "shadow" && normalizedBindings.environment !== "shadow") {
    throw new Error("shadow transactions must use the shadow environment");
  }
  if (
    mode === "activation" &&
    normalizedBindings.environment !== "production"
  ) {
    throw new Error(
      "activation transactions must use the production environment",
    );
  }
  const transaction = {
    schema: RELEASE_ACTIVATION_CONTRACT,
    transactionId: requiredString(transactionId, "transactionId"),
    mode,
    state: "open",
    releasedUseClaim: false,
    bindings: normalizedBindings,
    owners: normalizeOwners(owners),
    phases: RELEASE_ACTIVATION_PHASES.map((id) => ({
      id,
      status: "pending",
      attempts: 0,
      receiptRoots: [],
    })),
    retainedReceiptRoots: [],
    failure: null,
    rollback: null,
  };
  transaction.transactionRoot = releaseActivationRoot(transaction);
  return transaction;
}

export function validateReleaseActivationTransaction(transaction) {
  const issues = [];
  if (transaction?.schema !== RELEASE_ACTIVATION_CONTRACT) {
    issues.push(`schema must be ${RELEASE_ACTIVATION_CONTRACT}`);
  }
  try {
    normalizeBindings(transaction?.bindings);
    normalizeOwners(transaction?.owners);
  } catch (error) {
    issues.push(error.message);
  }
  if (!["shadow", "activation"].includes(transaction?.mode))
    issues.push("mode is invalid");
  if (
    !["open", "complete", "aborted", "rolled-back"].includes(
      transaction?.state,
    )
  ) {
    issues.push("state is invalid");
  }
  if (
    !Array.isArray(transaction?.phases) ||
    transaction.phases.map((phase) => phase.id).join(",") !==
      RELEASE_ACTIVATION_PHASES.join(",")
  ) {
    issues.push("phases must preserve the canonical activation order");
  } else {
    let pendingSeen = false;
    for (const phase of transaction.phases) {
      if (!["pending", "passed", "failed", "rolled-back"].includes(phase.status)) {
        issues.push(`phase ${phase.id} has invalid status`);
      }
      if (phase.status === "pending") pendingSeen = true;
      if (pendingSeen && phase.status === "passed") {
        issues.push(`phase ${phase.id} passed after an incomplete predecessor`);
      }
      if (!Number.isSafeInteger(phase.attempts) || phase.attempts < 0) {
        issues.push(
          `phase ${phase.id} attempts must be a non-negative integer`,
        );
      }
      if (
        !Array.isArray(phase.receiptRoots) ||
        phase.receiptRoots.some((root) => !ROOT.test(root))
      ) {
        issues.push(`phase ${phase.id} receipt roots are invalid`);
      }
    }
  }
  if (
    transaction?.mode === "shadow" &&
    transaction?.releasedUseClaim !== false
  ) {
    issues.push("shadow transactions must never make a released-use claim");
  }
  if (
    transaction?.transactionRoot !== releaseActivationRoot(transaction || {})
  ) {
    issues.push("transactionRoot mismatch");
  }
  return { valid: issues.length === 0, issues };
}

function refresh(transaction) {
  transaction.retainedReceiptRoots = [
    ...new Set(transaction.phases.flatMap((phase) => phase.receiptRoots)),
  ].sort();
  transaction.transactionRoot = releaseActivationRoot(transaction);
  return transaction;
}

export function recordReleaseActivationPhase(
  transaction,
  phaseId,
  { receiptRoots = [], failure = "" } = {},
) {
  const validation = validateReleaseActivationTransaction(transaction);
  if (!validation.valid)
    throw new Error(
      `invalid activation transaction: ${validation.issues.join("; ")}`,
    );
  if (transaction.state !== "open") {
    if (transaction.state === "complete" && !failure)
      return structuredClone(transaction);
    throw new Error(
      `cannot record a phase while transaction state is ${transaction.state}`,
    );
  }
  const next = structuredClone(transaction);
  const index = RELEASE_ACTIVATION_PHASES.indexOf(phaseId);
  if (index < 0) throw new Error(`unknown activation phase: ${phaseId}`);
  if (
    next.phases.slice(0, index).some((phase) => phase.status !== "passed")
  ) {
    throw new Error(
      `activation phase ${phaseId} cannot skip an incomplete predecessor`,
    );
  }
  const phase = next.phases[index];
  const normalizedRoots = [
    ...new Set(
      receiptRoots.map((root, receiptIndex) =>
        exactRoot(root, `receiptRoots[${receiptIndex}]`),
      ),
    ),
  ].sort();
  if (phase.status === "passed") {
    if (stableJson(phase.receiptRoots) !== stableJson(normalizedRoots)) {
      throw new Error(
        `activation phase ${phaseId} replay changed receipt roots`,
      );
    }
    return next;
  }
  phase.attempts += 1;
  phase.receiptRoots = normalizedRoots;
  if (failure) {
    phase.status = "failed";
    next.failure = {
      phase: phaseId,
      reason: requiredString(failure, "failure"),
    };
    return refresh(next);
  }
  phase.status = "passed";
  next.failure = null;
  if (index === RELEASE_ACTIVATION_PHASES.length - 1)
    next.state = "complete";
  return refresh(next);
}

export function abortReleaseActivationTransaction(transaction, reason) {
  if (transaction.state === "complete")
    throw new Error("completed activation transactions cannot be aborted");
  const next = structuredClone(transaction);
  next.state = "aborted";
  next.failure = {
    phase:
      next.phases.find((phase) => phase.status !== "passed")?.id || "",
    reason: requiredString(reason, "reason"),
  };
  return refresh(next);
}

export function rollbackReleaseActivationTransaction(
  transaction,
  { toSiteSourceSha, reason } = {},
) {
  if (!["complete", "aborted"].includes(transaction.state)) {
    throw new Error(
      "rollback requires a complete or aborted activation transaction",
    );
  }
  const next = structuredClone(transaction);
  next.state = "rolled-back";
  next.rollback = {
    toSiteSourceSha: exactSha(toSiteSourceSha, "toSiteSourceSha"),
    reason: requiredString(reason, "reason"),
  };
  for (const phase of next.phases.slice(3).reverse()) {
    if (phase.status === "passed") phase.status = "rolled-back";
  }
  return refresh(next);
}

export function createReleaseActivationReceiptSet({
  transaction,
  receipts = [],
} = {}) {
  const validation = validateReleaseActivationTransaction(transaction);
  if (!validation.valid)
    throw new Error(
      `invalid activation transaction: ${validation.issues.join("; ")}`,
    );
  if (transaction.state !== "complete")
    throw new Error(
      "receipt synthesis requires a complete activation transaction",
    );
  const byKind = new Map();
  for (const [index, receipt] of receipts.entries()) {
    const kind = requiredString(receipt?.kind, `receipts[${index}].kind`);
    if (!RECEIPT_KINDS.includes(kind))
      throw new Error(`unsupported activation receipt kind: ${kind}`);
    if (byKind.has(kind))
      throw new Error(`duplicate activation receipt kind: ${kind}`);
    byKind.set(kind, {
      kind,
      root: exactRoot(receipt.root, `receipts[${index}].root`),
      bindingRoot: exactRoot(
        receipt.bindingRoot,
        `receipts[${index}].bindingRoot`,
      ),
      locator: requiredString(
        receipt.locator,
        `receipts[${index}].locator`,
      ),
    });
  }
  for (const kind of RECEIPT_KINDS) {
    if (!byKind.has(kind))
      throw new Error(`activation receipt set is missing ${kind}`);
  }
  const bindingRoot = releaseActivationRoot(transaction.bindings);
  if (
    [...byKind.values()].some(
      (receipt) => receipt.bindingRoot !== bindingRoot,
    )
  ) {
    throw new Error(
      "activation receipts do not bind the exact transaction inputs",
    );
  }
  const receiptSet = {
    schema: RELEASE_ACTIVATION_RECEIPT_SET_CONTRACT,
    transactionId: transaction.transactionId,
    transactionRoot: transaction.transactionRoot,
    mode: transaction.mode,
    releasedUseClaim: transaction.mode === "activation",
    bindings: structuredClone(transaction.bindings),
    receipts: RECEIPT_KINDS.map((kind) => byKind.get(kind)),
    legalBoundary: {
      firstUseDateClaim: null,
      legalConclusion: "not-made",
      registrationStatusClaim: "none",
    },
  };
  receiptSet.receiptSetRoot = releaseActivationRoot(receiptSet);
  return receiptSet;
}

export function validateReleaseActivationReceiptSet(
  receiptSet,
  { allowShadow = true } = {},
) {
  const issues = [];
  if (receiptSet?.schema !== RELEASE_ACTIVATION_RECEIPT_SET_CONTRACT) {
    issues.push(`schema must be ${RELEASE_ACTIVATION_RECEIPT_SET_CONTRACT}`);
  }
  try {
    normalizeBindings(receiptSet?.bindings);
  } catch (error) {
    issues.push(error.message);
  }
  if (!allowShadow && receiptSet?.mode !== "activation")
    issues.push("released evidence requires activation mode");
  if (
    receiptSet?.mode === "shadow" &&
    receiptSet?.releasedUseClaim !== false
  ) {
    issues.push("shadow receipt sets must not claim released use");
  }
  const receipts = Array.isArray(receiptSet?.receipts)
    ? receiptSet.receipts
    : [];
  if (
    receipts.map((receipt) => receipt.kind).join(",") !==
    RECEIPT_KINDS.join(",")
  ) {
    issues.push(
      "receipt kinds are missing, duplicated, or out of canonical order",
    );
  }
  const bindingRoot = releaseActivationRoot(receiptSet?.bindings || {});
  for (const receipt of receipts) {
    if (!ROOT.test(receipt?.root || ""))
      issues.push(`${receipt?.kind || "receipt"} root is invalid`);
    if (receipt?.bindingRoot !== bindingRoot)
      issues.push(`${receipt?.kind || "receipt"} binding root mismatch`);
    if (!String(receipt?.locator || "").trim())
      issues.push(`${receipt?.kind || "receipt"} locator is missing`);
  }
  if (receiptSet?.receiptSetRoot !== releaseActivationRoot(receiptSet || {})) {
    issues.push("receiptSetRoot mismatch");
  }
  return { valid: issues.length === 0, issues };
}
