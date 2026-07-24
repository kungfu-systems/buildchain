import crypto from "node:crypto";

import { validateControllerReceipt } from "./controller-evidence.js";

export const WEB_SURFACE_PUBLICATION_CANDIDATE_CONTRACT =
  "kungfu-buildchain-web-surface-publication-candidate";
export const WEB_SURFACE_PRODUCTION_DECISION_CONTRACT =
  "kungfu-buildchain-web-surface-production-decision";

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

export function webSurfacePublicationDigest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function normalizeDigest(value, label) {
  const normalized = requiredString(value, label).replace(/^sha256:/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a sha256 digest`);
  return normalized;
}

function normalizeGitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
    throw new Error(`${label} must be a 40- or 64-character Git SHA`);
  }
  return normalized;
}

export function createWebSurfaceProductionDecision({
  approved,
  kind,
  repository,
  sourceSha,
  actor,
  actorPermission = "",
  releasePr = 0,
  releaseSource = "",
  reason,
} = {}) {
  const normalizedKind = requiredString(kind, "kind");
  if (!["manual-dispatch", "release-pr", "none"].includes(normalizedKind)) {
    throw new Error(`unsupported web-surface production decision kind: ${normalizedKind}`);
  }
  const payload = {
    schemaVersion: 1,
    contract: WEB_SURFACE_PRODUCTION_DECISION_CONTRACT,
    approved: approved === true,
    kind: normalizedKind,
    repository: requiredString(repository, "repository"),
    sourceSha: normalizeGitSha(sourceSha, "sourceSha"),
    actor: requiredString(actor, "actor"),
    actorPermission: String(actorPermission || ""),
    releasePr: Number(releasePr || 0),
    releaseSource: String(releaseSource || ""),
    reason: requiredString(reason, "reason"),
  };
  if (!Number.isSafeInteger(payload.releasePr) || payload.releasePr < 0) {
    throw new Error("releasePr must be a non-negative safe integer");
  }
  return { ...payload, decisionDigest: webSurfacePublicationDigest(payload) };
}

export function createWebSurfacePublicationCandidate({
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
  plan,
  planFileDigest,
  controllerReceipt,
  decision,
} = {}) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedSourceSha = normalizeGitSha(sourceSha, "sourceSha");
  const normalizedSourceTreeSha = normalizeGitSha(sourceTreeSha, "sourceTreeSha");
  const normalizedRuntimeSha = normalizeGitSha(runtimeSha, "runtimeSha");
  if (plan?.contract !== "kungfu-buildchain-web-surface-deploy-plan") {
    throw new Error("web-surface publication plan contract mismatch");
  }
  if (plan.channel !== "production" || plan.dryRun !== true) {
    throw new Error("web-surface publication requires a production dry-run plan");
  }
  if (plan.manifest?.sourceSha !== normalizedSourceSha) {
    throw new Error("web-surface publication plan source SHA mismatch");
  }
  const artifactHash = normalizeDigest(plan.artifact?.hash, "plan.artifact.hash");
  if (normalizeDigest(plan.manifest?.artifactHash, "plan.manifest.artifactHash") !== artifactHash) {
    throw new Error("web-surface publication plan artifact hash mismatch");
  }
  if (plan.manifest?.runtimeId && String(plan.manifest.runtimeId).toLowerCase() !== normalizedRuntimeSha) {
    throw new Error("web-surface publication plan runtime SHA mismatch");
  }
  const canonicalPlanDigest = crypto
    .createHash("sha256")
    .update(`${JSON.stringify(plan, null, 2)}\n`)
    .digest("hex");
  if (normalizeDigest(planFileDigest, "planFileDigest") !== canonicalPlanDigest) {
    throw new Error("web-surface publication plan file digest mismatch");
  }
  const controllerValidation = validateControllerReceipt(controllerReceipt, {
    expectedSourceSha: normalizedSourceSha,
    expectedRuntimeSha: normalizedRuntimeSha,
  });
  if (!controllerValidation.ok || !controllerValidation.qualifying) {
    throw new Error(`web-surface publication controller receipt did not qualify: ${controllerValidation.issues.join("; ")}`);
  }
  const planEvidence = (controllerReceipt.evidence || []).filter(
    (entry) => entry.kind === "web-surface-plan",
  );
  if (
    planEvidence.length !== 1 ||
    normalizeDigest(planEvidence[0].digest, "controllerReceipt.web-surface-plan.digest") !== canonicalPlanDigest
  ) {
    throw new Error("web-surface publication controller receipt plan evidence mismatch");
  }
  if (decision?.contract !== WEB_SURFACE_PRODUCTION_DECISION_CONTRACT || decision.approved !== true) {
    throw new Error("web-surface production decision is not approved");
  }
  const { decisionDigest: suppliedDecisionDigest, ...decisionPayload } = decision;
  const decisionDigest = webSurfacePublicationDigest(decisionPayload);
  if (normalizeDigest(suppliedDecisionDigest, "decision.decisionDigest") !== decisionDigest) {
    throw new Error("web-surface production decision digest mismatch");
  }
  if (decision.repository !== normalizedRepository || decision.sourceSha !== normalizedSourceSha) {
    throw new Error("web-surface production decision source binding mismatch");
  }
  if (!["manual-dispatch", "release-pr"].includes(decision.kind)) {
    throw new Error("web-surface production decision kind is not authorizing");
  }
  const payload = {
    schemaVersion: 1,
    contract: WEB_SURFACE_PUBLICATION_CANDIDATE_CONTRACT,
    repository: normalizedRepository,
    sourceSha: normalizedSourceSha,
    sourceTreeSha: normalizedSourceTreeSha,
    runtimeSha: normalizedRuntimeSha,
    site: requiredString(plan.manifest?.site, "plan.manifest.site"),
    environment: "production",
    deployTarget: requiredString(plan.manifest?.deployTarget, "plan.manifest.deployTarget"),
    artifactHash,
    planDigest: canonicalPlanDigest,
    controllerReceiptDigest: normalizeDigest(controllerReceipt.digest, "controllerReceipt.digest"),
    decisionDigest,
  };
  return { ...payload, candidateDigest: webSurfacePublicationDigest(payload) };
}
