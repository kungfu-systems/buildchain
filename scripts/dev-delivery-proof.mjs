// SPDX-License-Identifier: Apache-2.0

import {
  canonical,
  contentRoot,
  exactSha,
  positiveInteger,
  repositoryName,
  requiredText,
  sha256Root,
  timestamp,
} from "./dev-delivery-warrant-contract.mjs";

export const SOURCE_QUALIFICATION_PROOF_SCHEMA =
  "kungfu-buildchain-source-qualification-proof/v1";
export const DEV_DELTA_CLASSIFICATION_SCHEMA =
  "kungfu-buildchain-dev-delta-classification/v1";
export const SOURCE_REPLAY_RECEIPT_SCHEMA =
  "kungfu-buildchain-source-replay-receipt/v1";
export const INTEGRATION_DELIVERY_PROOF_SCHEMA =
  "kungfu-buildchain-integration-delivery-proof/v1";
export const GITHUB_ENQUEUE_RECEIPT_SCHEMA =
  "kungfu-buildchain-dev-delivery-github-enqueue/v1";

function protectedBase(value) {
  const normalized = requiredText(value, "protected base").replace(
    /^refs\/heads\//u,
    "",
  );
  if (!/^dev\/v\d+\/v\d+\.\d+$/u.test(normalized)) {
    throw new Error("protected base must be a Buildchain dev channel");
  }
  return normalized;
}

function uniqueSorted(values, label, normalizer = requiredText) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => normalizer(value, label)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function relativePath(value, label) {
  const normalized = requiredText(value, label)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized === "."
  ) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

function normalizeShard(value, index) {
  const id = requiredText(value?.id, `affected shard ${index} id`);
  return {
    id,
    pathPrefixes: uniqueSorted(
      value?.pathPrefixes,
      `affected shard ${id} path prefixes`,
      relativePath,
    ),
    qualificationContext: requiredText(
      value?.qualificationContext,
      `affected shard ${id} qualification context`,
    ),
  };
}

function normalizeAffectedClosure(value) {
  const shards = (value?.shards || [])
    .map(normalizeShard)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (shards.length === 0) {
    throw new Error("affected closure must declare at least one shard");
  }
  if (new Set(shards.map((entry) => entry.id)).size !== shards.length) {
    throw new Error("affected closure shard ids must be unique");
  }
  const closure = {
    shards,
    unrelatedPathPrefixes: uniqueSorted(
      value?.unrelatedPathPrefixes || [],
      "unrelated path prefixes",
      relativePath,
    ),
  };
  return { ...closure, closureRoot: contentRoot(closure) };
}

function normalizeContexts(values, treeSha = "", treeLabel = "qualified tree") {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("required contexts must be a non-empty array");
  }
  const contexts = values
    .map((value, index) => ({
      name: requiredText(value?.name, `required context ${index} name`),
      conclusion: requiredText(
        value?.conclusion,
        `required context ${index} conclusion`,
      ),
      ...(treeSha
        ? { headSha: exactSha(value?.headSha, `required context ${index} SHA`) }
        : {}),
      evidenceRoot: sha256Root(
        value?.evidenceRoot,
        `required context ${index} evidence root`,
      ),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(contexts.map((entry) => entry.name)).size !== contexts.length) {
    throw new Error("required context names must be unique");
  }
  for (const context of contexts) {
    if (context.conclusion !== "success") {
      throw new Error(`required context ${context.name} did not succeed`);
    }
    if (treeSha && context.headSha !== treeSha) {
      throw new Error(
        `required context ${context.name} is not for the ${treeLabel}`,
      );
    }
  }
  return contexts;
}

function rooted(body, field) {
  return { ...body, [field]: contentRoot(body) };
}

function assertRooted(value, schema, field) {
  if (!value || value.schema !== schema) {
    throw new Error(`value must use ${schema}`);
  }
  const observed = sha256Root(value[field], field);
  const { [field]: _root, ...body } = value;
  if (contentRoot(body) !== observed) throw new Error(`${field} mismatch`);
  return value;
}

export function createSourceQualificationProof(input = {}) {
  const affectedClosure = normalizeAffectedClosure(input.affectedClosure);
  const sourceHeadSha = exactSha(input.sourceHeadSha, "source head SHA");
  const body = canonical({
    schema: SOURCE_QUALIFICATION_PROOF_SCHEMA,
    repository: repositoryName(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "pull request number",
    ),
    sourceHeadSha,
    semanticSourceRoot: sha256Root(
      input.semanticSourceRoot,
      "semantic source root",
    ),
    sourceIntentRoot: sha256Root(input.sourceIntentRoot, "source intent root"),
    planRoot: sha256Root(input.planRoot, "qualification plan root"),
    affectedClosure,
    dependencyGraphRoot: sha256Root(
      input.dependencyGraphRoot,
      "dependency graph root",
    ),
    toolchainRoot: sha256Root(input.toolchainRoot, "toolchain root"),
    requiredContexts: normalizeContexts(
      input.requiredContexts,
      sourceHeadSha,
      "source head",
    ),
    evidenceRoots: uniqueSorted(
      input.evidenceRoots,
      "source qualification evidence roots",
      sha256Root,
    ),
  });
  return rooted(body, "sourceProofRoot");
}

export function verifySourceQualificationProof(proof, expected = {}) {
  assertRooted(proof, SOURCE_QUALIFICATION_PROOF_SCHEMA, "sourceProofRoot");
  const normalized = createSourceQualificationProof(proof);
  if (normalized.sourceProofRoot !== proof.sourceProofRoot) {
    throw new Error("source qualification proof is not canonical");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && proof[field] !== value) {
      throw new Error(`source qualification ${field} mismatch`);
    }
  }
  return normalized;
}

function pathMatches(changedPath, prefix) {
  return changedPath === prefix || changedPath.startsWith(`${prefix}/`);
}

export function classifyDevDelta(input = {}) {
  const proof = verifySourceQualificationProof(input.sourceProof);
  const previousBaseSha = exactSha(input.previousBaseSha, "previous base SHA");
  const currentBaseSha = exactSha(input.currentBaseSha, "current base SHA");
  const dependencyGraphRoot = sha256Root(
    input.dependencyGraphRoot,
    "current dependency graph root",
  );
  const toolchainRoot = sha256Root(
    input.toolchainRoot,
    "current toolchain root",
  );
  const rootChanges = [];
  if (dependencyGraphRoot !== proof.dependencyGraphRoot) {
    rootChanges.push("dependency-graph-root-changed");
  }
  if (toolchainRoot !== proof.toolchainRoot) {
    rootChanges.push("toolchain-root-changed");
  }

  let changedPaths = null;
  let affectedShards = [];
  let unknownPaths = [];
  let mode;
  let reason;
  if (rootChanges.length > 0) {
    mode = "rerun-all";
    reason = rootChanges.join(",");
  } else if (!Array.isArray(input.changedPaths)) {
    mode = "rerun-all";
    reason = "unknown-attribution";
  } else {
    changedPaths = uniqueSorted(
      input.changedPaths,
      "changed paths",
      relativePath,
    );
    const affected = new Set();
    for (const changedPath of changedPaths) {
      const matching = proof.affectedClosure.shards.filter((shard) =>
        shard.pathPrefixes.some((prefix) => pathMatches(changedPath, prefix)),
      );
      for (const shard of matching) affected.add(shard.id);
      const explicitlyUnrelated =
        proof.affectedClosure.unrelatedPathPrefixes.some((prefix) =>
          pathMatches(changedPath, prefix),
        );
      if (matching.length === 0 && !explicitlyUnrelated)
        unknownPaths.push(changedPath);
    }
    affectedShards = [...affected].sort((left, right) =>
      left.localeCompare(right),
    );
    unknownPaths = unknownPaths.sort((left, right) =>
      left.localeCompare(right),
    );
    if (unknownPaths.length > 0) {
      mode = "rerun-all";
      reason = "unknown-attribution";
    } else if (affectedShards.length > 0) {
      mode = "rerun-affected";
      reason = "overlapping-dev-delta";
    } else {
      mode = "reuse-source-proof";
      reason =
        previousBaseSha === currentBaseSha
          ? "no-dev-delta"
          : "base-only-unrelated-delta";
    }
  }
  const body = canonical({
    schema: DEV_DELTA_CLASSIFICATION_SCHEMA,
    sourceProofRoot: proof.sourceProofRoot,
    previousBaseSha,
    currentBaseSha,
    dependencyGraphRoot,
    toolchainRoot,
    changedPaths,
    affectedShards,
    unknownPaths,
    rootChanges,
    mode,
    reason,
    sourceProofReusable: mode !== "rerun-all",
  });
  return rooted(body, "classificationRoot");
}

export function verifyDevDeltaClassification(value, expected = {}) {
  assertRooted(value, DEV_DELTA_CLASSIFICATION_SCHEMA, "classificationRoot");
  const sourceProof = expected.sourceProof;
  if (!sourceProof) throw new Error("source proof is required");
  const recomputed = classifyDevDelta({
    sourceProof,
    previousBaseSha: value.previousBaseSha,
    currentBaseSha: value.currentBaseSha,
    changedPaths: value.changedPaths,
    dependencyGraphRoot: value.dependencyGraphRoot,
    toolchainRoot: value.toolchainRoot,
  });
  if (recomputed.classificationRoot !== value.classificationRoot) {
    throw new Error("dev delta classification semantic mismatch");
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (field === "sourceProof") continue;
    if (expectedValue !== undefined && value[field] !== expectedValue) {
      throw new Error(`dev delta ${field} mismatch`);
    }
  }
  return value;
}

function normalizeWarrant(value) {
  const issuedAt = timestamp(value?.issuedAt, "Warrant issued at").value;
  const expiresAt = timestamp(value?.expiresAt, "Warrant expires at").value;
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Warrant expiry must follow issuance");
  }
  return {
    warrantId: sha256Root(value?.warrantId, "Warrant id"),
    fencingToken: sha256Root(value?.fencingToken, "fencing token"),
    generation: positiveInteger(value?.generation, "fencing generation"),
    submissionId: sha256Root(value?.submissionId, "submission id"),
    issuedAt,
    expiresAt,
  };
}

export function planSourceReplay(input = {}) {
  const proof = verifySourceQualificationProof(input.sourceProof);
  const classification = verifyDevDeltaClassification(input.classification, {
    sourceProof: proof,
  });
  const sourceHeadSha = exactSha(
    input.sourceHeadSha,
    "current source head SHA",
  );
  const conflicts = uniqueSorted(
    input.conflicts || [],
    "replay conflicts",
    relativePath,
  );
  let action = "replay-on-latest-base";
  let reason = classification.reason;
  if (sourceHeadSha !== proof.sourceHeadSha) {
    action = "source-repair-required";
    reason = "source-head-changed";
  } else if (conflicts.length > 0) {
    action = "blocked-conflict";
    reason = "replay-conflict";
  }
  const body = canonical({
    schema: "kungfu-buildchain-source-replay-plan/v1",
    sourceProofRoot: proof.sourceProofRoot,
    classificationRoot: classification.classificationRoot,
    sourceHeadSha,
    previousBaseSha: classification.previousBaseSha,
    currentBaseSha: classification.currentBaseSha,
    action,
    reason,
    affectedShards: classification.affectedShards,
    sourceProofReusable: classification.sourceProofReusable,
    physicalPrHeadRewrite: false,
    conflicts,
  });
  return rooted(body, "replayPlanRoot");
}

export function createSourceReplayReceipt(input = {}) {
  const plan = input.plan;
  if (!plan || plan.schema !== "kungfu-buildchain-source-replay-plan/v1") {
    throw new Error("source replay plan is required");
  }
  assertRooted(plan, plan.schema, "replayPlanRoot");
  if (plan.action !== "replay-on-latest-base" || plan.physicalPrHeadRewrite) {
    throw new Error("only a no-head-rewrite replay plan can be receipted");
  }
  const warrant = normalizeWarrant(input.warrant);
  const replayedAt = timestamp(input.replayedAt, "replayed at").value;
  if (Date.parse(replayedAt) >= Date.parse(warrant.expiresAt)) {
    throw new Error("source replay occurred after Warrant expiry");
  }
  const body = canonical({
    schema: SOURCE_REPLAY_RECEIPT_SCHEMA,
    repository: repositoryName(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceProofRoot: sha256Root(plan.sourceProofRoot, "source proof root"),
    replayPlanRoot: plan.replayPlanRoot,
    replayPlan: plan,
    classificationRoot: plan.classificationRoot,
    sourceHeadSha: exactSha(plan.sourceHeadSha, "source head SHA"),
    previousBaseSha: exactSha(plan.previousBaseSha, "previous base SHA"),
    currentBaseSha: exactSha(plan.currentBaseSha, "current base SHA"),
    candidateTreeSha: exactSha(input.candidateTreeSha, "candidate tree SHA"),
    warrant,
    queueRevision: sha256Root(input.queueRevision, "queue revision"),
    affectedShards: [...plan.affectedShards],
    sourceProofReusable: Boolean(plan.sourceProofReusable),
    physicalPrHeadRewritten: false,
    replayedAt,
  });
  return rooted(body, "replayReceiptRoot");
}

export function verifySourceReplayReceipt(value, expected = {}) {
  assertRooted(value, SOURCE_REPLAY_RECEIPT_SCHEMA, "replayReceiptRoot");
  normalizeWarrant(value.warrant);
  if (value.physicalPrHeadRewritten !== false) {
    throw new Error("source replay receipt rewrote the physical PR head");
  }
  const proof = expected.sourceProof;
  const classification = expected.classification;
  if (!proof || !classification) {
    throw new Error("source proof and delta classification are required");
  }
  const plan = planSourceReplay({
    sourceProof: proof,
    classification,
    sourceHeadSha: value.replayPlan?.sourceHeadSha,
    conflicts: value.replayPlan?.conflicts,
  });
  if (plan.replayPlanRoot !== value.replayPlanRoot) {
    throw new Error("source replay plan semantic mismatch");
  }
  const recomputed = createSourceReplayReceipt({
    plan,
    repository: value.repository,
    protectedBase: value.protectedBase,
    candidateTreeSha: value.candidateTreeSha,
    warrant: value.warrant,
    queueRevision: value.queueRevision,
    replayedAt: value.replayedAt,
  });
  if (recomputed.replayReceiptRoot !== value.replayReceiptRoot) {
    throw new Error("source replay receipt semantic mismatch");
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (field === "sourceProof" || field === "classification") continue;
    if (expectedValue !== undefined && value[field] !== expectedValue) {
      throw new Error(`source replay ${field} mismatch`);
    }
  }
  return value;
}

export function createGithubEnqueueReceipt(input = {}) {
  const warrant = normalizeWarrant(input.warrant);
  const body = canonical({
    schema: GITHUB_ENQUEUE_RECEIPT_SCHEMA,
    repository: repositoryName(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    submissionId: sha256Root(input.submissionId, "submission id"),
    sourceHeadSha: exactSha(input.sourceHeadSha, "source head SHA"),
    warrantId: warrant.warrantId,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    expiresAt: warrant.expiresAt,
    queueEntryId: requiredText(input.queueEntryId, "merge queue entry id"),
    queueEntryState: requiredText(
      input.queueEntryState,
      "merge queue entry state",
    ),
    recoveredAfterControllerRestart: Boolean(
      input.recoveredAfterControllerRestart,
    ),
    queueRevision: sha256Root(input.queueRevision, "queue revision"),
  });
  return rooted(body, "receiptRoot");
}

export function verifyGithubEnqueueReceipt(receipt, expected = {}) {
  assertRooted(receipt, GITHUB_ENQUEUE_RECEIPT_SCHEMA, "receiptRoot");
  const recomputed = createGithubEnqueueReceipt({
    ...receipt,
    warrant: expected.warrant,
  });
  if (recomputed.receiptRoot !== receipt.receiptRoot) {
    throw new Error("GitHub enqueue receipt is not canonical");
  }
  for (const [field, value] of Object.entries(expected)) {
    if (field === "warrant") continue;
    if (value !== undefined && receipt[field] !== value) {
      throw new Error(`GitHub enqueue ${field} mismatch`);
    }
  }
  return recomputed;
}

export function createIntegrationDeliveryProof(input = {}) {
  const warrant = normalizeWarrant(input.warrant);
  const providerReceipt = verifyGithubEnqueueReceipt(input.providerReceipt, {
    repository: input.repository,
    protectedBase: input.protectedBase,
    submissionId: warrant.submissionId,
    warrant,
    queueRevision: input.queueRevision,
  });
  const integrationTreeSha = exactSha(
    input.integrationTreeSha,
    "integration tree SHA",
  );
  const verifiedAt = timestamp(
    input.verifiedAt,
    "integration verified at",
  ).value;
  if (Date.parse(verifiedAt) >= Date.parse(warrant.expiresAt)) {
    throw new Error("integration proof was verified after Warrant expiry");
  }
  const body = canonical({
    schema: INTEGRATION_DELIVERY_PROOF_SCHEMA,
    repository: repositoryName(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceProofRoot: sha256Root(input.sourceProofRoot, "source proof root"),
    replayReceiptRoot: sha256Root(
      input.replayReceiptRoot,
      "source replay receipt root",
    ),
    classificationRoot: sha256Root(
      input.classificationRoot,
      "dev delta classification root",
    ),
    integrationTreeSha,
    protectedBaseSha: exactSha(input.protectedBaseSha, "protected base SHA"),
    warrant,
    queueRevision: sha256Root(input.queueRevision, "queue revision"),
    providerReceiptRoot: providerReceipt.receiptRoot,
    requiredContexts: normalizeContexts(
      input.requiredContexts,
      integrationTreeSha,
      "integration tree",
    ),
    verifiedAt,
  });
  return rooted(body, "integrationProofRoot");
}

export function verifyIntegrationDeliveryProof(proof, expected = {}) {
  assertRooted(
    proof,
    INTEGRATION_DELIVERY_PROOF_SCHEMA,
    "integrationProofRoot",
  );
  const providerReceipt = expected.providerReceipt;
  if (!providerReceipt) throw new Error("provider receipt is required");
  const recomputed = createIntegrationDeliveryProof({
    ...proof,
    providerReceipt,
  });
  if (recomputed.integrationProofRoot !== proof.integrationProofRoot) {
    throw new Error("integration delivery proof is not canonical");
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (field === "providerReceipt") continue;
    if (expectedValue !== undefined && proof[field] !== expectedValue) {
      throw new Error(`integration delivery ${field} mismatch`);
    }
  }
  return proof;
}
