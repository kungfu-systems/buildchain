import {
  assertString,
  optionalString,
} from "./release-propagation-common.js";
import {
  assertContentRoot,
  assertExactFields,
  assertIsoTimestamp,
  contentRoot,
} from "./release-propagation-work-control.js";
import {
  FAILURE_DISPOSITIONS,
  RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
} from "./release-propagation-work-constants.js";

const REQUIRED_EVIDENCE_KINDS = Object.freeze({
  materialize: ["release-lock"],
  "verify-release": ["release-contract-verification"],
  "push-branch": ["git-branch-reconciliation"],
  "pull-request": ["github-pull-request"],
  preview: ["preview-deployment"],
  "independent-review": ["github-pr-approval"],
  "protected-merge": ["github-merge"],
  staging: ["staging-deployment"],
  "production-release": ["production-release-pr"],
  "production-deploy": ["production-deployment", "rollback-coordinate"],
  "online-readback": ["production-status", "online-artifact"],
  complete: ["work-control-decision"],
});

const COMMIT_BOUND_STAGES = new Set([
  "push-branch",
  "pull-request",
  "preview",
  "independent-review",
  "protected-merge",
  "staging",
  "production-release",
  "production-deploy",
  "online-readback",
]);

function assertHttpsLocator(locator, stage) {
  if (!/^https:\/\/[^?\s]+$/.test(locator)) {
    throw new Error(`${stage} evidence locator must be a stable HTTPS URL without query parameters`);
  }
}

function verifyOnlineReadback(work, evidence) {
  const profile = work.downstream.executionProfile;
  const expectedLocators = [profile.productionStatusUrl, ...profile.readbackUrls].sort();
  const actualLocators = evidence.map((entry) => entry.locator).sort();
  if (JSON.stringify(actualLocators) !== JSON.stringify(expectedLocators)) {
    throw new Error("online-readback evidence must cover the exact production status and artifact URLs");
  }
  for (const entry of evidence) assertHttpsLocator(entry.locator, "online-readback");
  if (evidence.some((entry) => entry.httpStatus !== 200 || entry.bytes < 1)) {
    throw new Error("online-readback evidence must bind HTTP 200 and observed production bytes");
  }
  const status = evidence.find((entry) => entry.locator === profile.productionStatusUrl);
  if (status?.kind !== "production-status") {
    throw new Error("online-readback status URL requires production-status evidence");
  }
  if (evidence.some((entry) => entry !== status && entry.kind !== "online-artifact")) {
    throw new Error("online-readback artifact URLs require online-artifact evidence");
  }
}

export function validateStageEvidence({ work, receipt }) {
  if (receipt.outcome !== "success") return;
  const requiredKinds = REQUIRED_EVIDENCE_KINDS[receipt.stage] || [];
  const kinds = new Set(receipt.evidence.map((entry) => entry.kind));
  if (requiredKinds.some((kind) => !kinds.has(kind))) {
    throw new Error(`${receipt.stage} receipt is missing stage-specific evidence`);
  }
  if (receipt.evidence.some((entry) => entry.repository !== work.downstream.repository)) {
    throw new Error(`${receipt.stage} evidence repository disagrees with the propagation target`);
  }
  if (COMMIT_BOUND_STAGES.has(receipt.stage)
      && receipt.evidence.some((entry) => !/^[0-9a-f]{40}$/.test(entry.revision))) {
    throw new Error(`${receipt.stage} evidence must bind an exact downstream Git revision`);
  }
  if (new Set([
    "pull-request", "preview", "independent-review", "protected-merge",
    "staging", "production-release", "production-deploy",
  ]).has(receipt.stage)) {
    for (const entry of receipt.evidence) assertHttpsLocator(entry.locator, receipt.stage);
  }
  if (receipt.stage === "independent-review"
      && receipt.actor.identity === work.authority.executionWarrant?.identity) {
    throw new Error("independent-review actor must differ from the executing Warrant identity");
  }
  if (receipt.stage === "online-readback") verifyOnlineReadback(work, receipt.evidence);
}

function normalizeEvidence(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    const evidence = assertExactFields(entry, [
      "kind",
      "root",
      "locator",
      "repository",
      "revision",
      "httpStatus",
      "bytes",
    ], `${label}[${index}]`);
    const locator = assertString(evidence.locator, `${label}[${index}].locator`);
    if (/[?&](?:token|signature|x-amz-|x-goog-)/i.test(locator)) {
      throw new Error(`${label}[${index}].locator must not contain signed or credential parameters`);
    }
    const httpStatus = evidence.httpStatus === null ? null : Number(evidence.httpStatus);
    const bytes = Number(evidence.bytes);
    if (httpStatus !== null
        && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
      throw new Error(`${label}[${index}].httpStatus must be null or a valid HTTP status`);
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new Error(`${label}[${index}].bytes must be a non-negative integer`);
    }
    return {
      kind: assertString(evidence.kind, `${label}[${index}].kind`),
      root: assertContentRoot(evidence.root, `${label}[${index}].root`),
      locator,
      repository: optionalString(evidence.repository),
      revision: optionalString(evidence.revision),
      httpStatus,
      bytes,
    };
  });
}

export function normalizeStageReceipt(value, {
  work,
  workId,
  expectedWorkRoot,
  expectedStage,
  allowedOutcomes,
}) {
  const receipt = assertExactFields(value, [
    "schemaVersion",
    "contract",
    "workId",
    "expectedWorkRoot",
    "stage",
    "outcome",
    "attempt",
    "observedAt",
    "actor",
    "summary",
    "evidence",
    "failure",
    "receiptRoot",
  ], "stage receipt");
  if (receipt.schemaVersion !== 1 || receipt.contract !== RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT) {
    throw new Error("stage receipt must use the Buildchain release propagation stage receipt v1 contract");
  }
  if (receipt.workId !== workId || receipt.expectedWorkRoot !== expectedWorkRoot) {
    throw new Error("stage receipt does not bind the expected propagation work cut");
  }
  if (receipt.stage !== expectedStage) {
    throw new Error(`stage receipt must target current stage ${expectedStage}`);
  }
  if (!allowedOutcomes.has(receipt.outcome)) {
    throw new Error(`stage receipt outcome must be one of ${[...allowedOutcomes].join(", ")}`);
  }
  if (!Number.isInteger(receipt.attempt) || receipt.attempt < 1) {
    throw new Error("stage receipt attempt must be a positive integer");
  }
  const actor = assertExactFields(receipt.actor, ["kind", "identity"], "stage receipt actor");
  const normalized = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_STAGE_RECEIPT_CONTRACT,
    workId,
    expectedWorkRoot,
    stage: expectedStage,
    outcome: receipt.outcome,
    attempt: receipt.attempt,
    observedAt: assertIsoTimestamp(receipt.observedAt, "stage receipt observedAt"),
    actor: {
      kind: assertString(actor.kind, "stage receipt actor.kind"),
      identity: assertString(actor.identity, "stage receipt actor.identity"),
    },
    summary: assertString(receipt.summary, "stage receipt summary"),
    evidence: normalizeEvidence(receipt.evidence, "stage receipt evidence"),
    failure: null,
  };
  if (receipt.outcome === "failure") {
    const failure = assertExactFields(receipt.failure, ["class", "code", "summary"], "stage receipt failure");
    const failureClass = assertString(failure.class, "stage receipt failure.class");
    if (!FAILURE_DISPOSITIONS.has(failureClass)) {
      throw new Error(`unsupported propagation failure class: ${failureClass}`);
    }
    normalized.failure = {
      class: failureClass,
      code: assertString(failure.code, "stage receipt failure.code"),
      summary: assertString(failure.summary, "stage receipt failure.summary"),
    };
  } else if (receipt.failure !== null) {
    throw new Error("successful or repair stage receipt cannot carry failure data");
  }
  const expectedReceiptRoot = contentRoot(normalized);
  if (receipt.receiptRoot !== expectedReceiptRoot) {
    throw new Error("stage receipt root does not verify");
  }
  validateStageEvidence({ work, receipt: normalized });
  return { ...normalized, receiptRoot: expectedReceiptRoot };
}
