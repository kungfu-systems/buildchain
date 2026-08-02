import {
  assertPlainObject,
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

function exactClaims(entry, fields, label) {
  const claims = assertExactFields(entry.claims, fields, label);
  if (entry.root !== contentRoot(claims)) {
    throw new Error(`${label} root does not bind its exact claims`);
  }
  return claims;
}

function releaseClaims(work) {
  return {
    releaseRoot: work.upstream.releaseRoot,
    releaseLockRoot: `sha256:${work.downstream.lockSha256}`,
    sourceSha: work.upstream.release.sourceSha,
    tagTargetSha: work.upstream.release.tagTargetSha,
  };
}

function assertReleaseClaims(work, claims, label) {
  const expected = releaseClaims(work);
  for (const [field, value] of Object.entries(expected)) {
    if (claims[field] !== value) {
      throw new Error(`${label}.${field} does not bind the propagation release`);
    }
  }
}

function verifyIndependentReview(work, receipt) {
  if (receipt.actor.kind !== "github-reviewer") {
    throw new Error("independent-review actor must be a verified GitHub reviewer");
  }
  const approval = receipt.evidence.find((entry) => entry.kind === "github-pr-approval");
  const claims = exactClaims(approval, [
    "provider",
    "reviewState",
    "reviewerIdentity",
    "pullRequestAuthorIdentity",
    "headRevision",
  ], "independent-review evidence claims");
  if (claims.provider !== "github" || claims.reviewState !== "APPROVED") {
    throw new Error("independent-review must bind an approved GitHub review");
  }
  if (claims.reviewerIdentity !== receipt.actor.identity
      || claims.pullRequestAuthorIdentity !== work.authority.sourceControlPrincipal) {
    throw new Error("independent-review identities disagree with the receipt and source-control authority");
  }
  if (new Set([
    work.authority.executionPrincipal,
    work.authority.sourceControlPrincipal,
  ]).has(claims.reviewerIdentity)) {
    throw new Error("independent-review identity must differ from the executor and pull request author");
  }
  const pullRequest = [...work.stageReceipts]
    .reverse()
    .find((entry) => entry.stage === "pull-request" && entry.outcome === "success");
  const expectedHead = pullRequest?.evidence.find((entry) => entry.kind === "github-pull-request")?.revision;
  if (!expectedHead || claims.headRevision !== expectedHead || approval.revision !== expectedHead) {
    throw new Error("independent-review must bind the exact propagated pull request head");
  }
}

function verifyProductionDeployment(work, receipt) {
  const deployment = receipt.evidence.find((entry) => entry.kind === "production-deployment");
  const claims = exactClaims(deployment, [
    "deploymentRunUrl",
    "deployedRevision",
    "releaseRoot",
    "releaseLockRoot",
    "sourceSha",
    "tagTargetSha",
    "artifactRoot",
    "readbackArtifacts",
  ], "production-deployment evidence claims");
  assertReleaseClaims(work, claims, "production-deployment evidence claims");
  if (claims.deploymentRunUrl !== deployment.locator
      || claims.deployedRevision !== deployment.revision) {
    throw new Error("production-deployment evidence must bind its run and deployed revision");
  }
  assertContentRoot(claims.artifactRoot, "production-deployment evidence claims.artifactRoot");
  if (!Array.isArray(claims.readbackArtifacts)) {
    throw new Error("production-deployment readbackArtifacts must be an array");
  }
  const artifacts = claims.readbackArtifacts.map((entry, index) => {
    const artifact = assertExactFields(entry, ["url", "contentSha256"], `readbackArtifacts[${index}]`);
    return {
      url: assertString(artifact.url, `readbackArtifacts[${index}].url`),
      contentSha256: assertContentRoot(
        artifact.contentSha256,
        `readbackArtifacts[${index}].contentSha256`,
      ),
    };
  });
  const expectedUrls = work.downstream.executionProfile.readbackUrls;
  if (JSON.stringify(artifacts.map((entry) => entry.url)) !== JSON.stringify(expectedUrls)) {
    throw new Error("production-deployment readback artifacts must cover the exact profile URLs");
  }
  const rollback = receipt.evidence.find((entry) => entry.kind === "rollback-coordinate");
  const rollbackClaims = exactClaims(rollback, [
    "deployedRevision",
    "rollbackRevision",
  ], "rollback-coordinate evidence claims");
  if (rollbackClaims.deployedRevision !== deployment.revision
      || rollbackClaims.rollbackRevision !== rollback.revision) {
    throw new Error("rollback-coordinate must bind the deployed and rollback revisions");
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
  const deploymentReceipt = [...work.stageReceipts]
    .reverse()
    .find((entry) => entry.stage === "production-deploy" && entry.outcome === "success");
  const deployment = deploymentReceipt?.evidence.find(
    (entry) => entry.kind === "production-deployment",
  );
  if (!deployment) {
    throw new Error("online-readback requires a qualifying production deployment receipt");
  }
  const deploymentClaims = exactClaims(deployment, [
    "deploymentRunUrl",
    "deployedRevision",
    "releaseRoot",
    "releaseLockRoot",
    "sourceSha",
    "tagTargetSha",
    "artifactRoot",
    "readbackArtifacts",
  ], "production-deployment evidence claims");
  const expectedArtifacts = new Map(
    deploymentClaims.readbackArtifacts.map((entry) => [entry.url, entry.contentSha256]),
  );
  for (const entry of evidence) {
    const claims = exactClaims(entry, [
      "deployedRevision",
      "releaseRoot",
      "releaseLockRoot",
      "sourceSha",
      "tagTargetSha",
      "artifactRoot",
      "contentSha256",
    ], "online-readback evidence claims");
    assertReleaseClaims(work, claims, "online-readback evidence claims");
    assertContentRoot(claims.contentSha256, "online-readback evidence claims.contentSha256");
    if (claims.deployedRevision !== deployment.revision
        || claims.artifactRoot !== deploymentClaims.artifactRoot
        || entry.revision !== deployment.revision) {
      throw new Error("online-readback evidence does not bind the production deployment");
    }
    if (entry.kind === "online-artifact"
        && claims.contentSha256 !== expectedArtifacts.get(entry.locator)) {
      throw new Error("online artifact digest does not match the deployed readback artifact");
    }
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
  if (receipt.stage === "independent-review") verifyIndependentReview(work, receipt);
  if (receipt.stage === "production-deploy") verifyProductionDeployment(work, receipt);
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
      "claims",
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
    const claims = evidence.claims === null
      ? null
      : structuredClone(assertPlainObject(evidence.claims, `${label}[${index}].claims`));
    return {
      kind: assertString(evidence.kind, `${label}[${index}].kind`),
      root: assertContentRoot(evidence.root, `${label}[${index}].root`),
      locator,
      repository: optionalString(evidence.repository),
      revision: optionalString(evidence.revision),
      httpStatus,
      bytes,
      claims,
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
