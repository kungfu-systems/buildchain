import {
  devDeliveryClone as clone,
  devDeliveryContentRoot as contentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryText as text,
} from "./dev-delivery-common.js";
import { evaluateBuildchainChannelBinding } from "./buildchain-channel-identity.js";
import {
  assertBuildchainCompatibilityProjection,
  createBuildchainCompatibilityProofRegistry,
  resolveBuildchainCompatibilityProof,
} from "./buildchain-compatibility-fact.js";

export {
  BUILDCHAIN_COMPATIBILITY_FACT_REGISTRY_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_FACT_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA,
  assertBuildchainCompatibilityProjection,
  createBuildchainCompatibilityFact,
  createBuildchainCompatibilityFactRegistry,
  createBuildchainCompatibilityPathQuery,
  createBuildchainCompatibilityProof,
  createBuildchainCompatibilityProofRegistry,
  createHistoricalBuildchainCompatibilityFacts,
  createHistoricalBuildchainCompatibilityProofs,
  resolveBuildchainCompatibilityProof,
  verifyBuildchainCompatibilityFact,
  verifyBuildchainCompatibilityPath,
  verifyBuildchainCompatibilityProof,
} from "./buildchain-compatibility-fact.js";

export const BUILDCHAIN_LEGACY_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA =
  "kungfu.buildchain.compatibility-verification-receipt/v1";
export const BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA =
  "kungfu.buildchain.compatibility-verification-receipt/v2";

const BUILDCHAIN_CONTRACT = "kungfu-buildchain-runtime-contract-world";
const COMPATIBILITY_OPERATION = "accept-contract-lock";
const COMPATIBILITY_DIRECTION = "source-to-target";

function exactText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export function createBuildchainCompatibilityVerificationReceipt(input = {}) {
  const decisions = clone(input.decisions || []);
  const usedProofRoots = [
    ...new Set(
      decisions
        .map((decision) => decision.proofRoot)
        .filter(Boolean)
        .map((root) => exactRoot(root, "decision.proofRoot")),
    ),
  ].sort();
  const usedFactRoots = [
    ...new Set(
      decisions
        .map((decision) => decision.factRoot)
        .filter(Boolean)
        .map((root) => exactRoot(root, "decision.factRoot")),
    ),
  ].sort();
  const pathReceiptRoots = [
    ...new Set(
      decisions
        .map((decision) => decision.pathReceiptRoot)
        .filter(Boolean)
        .map((root) => exactRoot(root, "decision.pathReceiptRoot")),
    ),
  ].sort();
  const body = {
    schema: BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
    operation: COMPATIBILITY_OPERATION,
    direction: COMPATIBILITY_DIRECTION,
    status: exactText(input.status, "status"),
    compatible: input.compatible === true,
    policy: exactText(input.policy, "policy"),
    scope: clone(input.scope || {}),
    acceptedContractDigest: text(input.acceptedContractDigest),
    acceptedCompatibilityDigest: text(input.acceptedCompatibilityDigest),
    acceptedFactRegistryRoot: text(input.acceptedFactRegistryRoot),
    acceptedProofRegistryRoot: text(input.acceptedProofRegistryRoot),
    currentContractDigest: text(input.currentContractDigest),
    currentCompatibilityDigest: text(input.currentCompatibilityDigest),
    currentFactRegistryRoot: exactRoot(
      input.currentFactRegistryRoot,
      "currentFactRegistryRoot",
    ),
    currentFactCutRoot: exactRoot(
      input.currentFactCutRoot,
      "currentFactCutRoot",
    ),
    currentProofRegistryRoot: text(input.currentProofRegistryRoot),
    decisions,
    usedProofRoots,
    usedFactRoots,
    pathReceiptRoots,
    reasonCodes: [
      ...new Set(
        (input.reasonCodes || []).map((reason) =>
          exactText(reason, "reasonCode"),
        ),
      ),
    ].sort(),
  };
  return { ...body, receiptRoot: contentRoot(body) };
}

function createLegacyCompatibilityVerificationReceipt(input = {}) {
  const decisions = clone(input.decisions || []);
  const body = {
    schema: BUILDCHAIN_LEGACY_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
    operation: COMPATIBILITY_OPERATION,
    direction: COMPATIBILITY_DIRECTION,
    status: exactText(input.status, "status"),
    compatible: input.compatible === true,
    policy: exactText(input.policy, "policy"),
    scope: clone(input.scope || {}),
    acceptedContractDigest: text(input.acceptedContractDigest),
    acceptedCompatibilityDigest: text(input.acceptedCompatibilityDigest),
    acceptedProofRegistryRoot: text(input.acceptedProofRegistryRoot),
    currentContractDigest: text(input.currentContractDigest),
    currentCompatibilityDigest: text(input.currentCompatibilityDigest),
    currentProofRegistryRoot: text(input.currentProofRegistryRoot),
    decisions,
    usedProofRoots: [
      ...new Set(
        decisions
          .map((decision) => decision.proofRoot)
          .filter(Boolean)
          .map((entry) => exactRoot(entry, "decision.proofRoot")),
      ),
    ].sort(),
    reasonCodes: [
      ...new Set(
        (input.reasonCodes || []).map((reason) =>
          exactText(reason, "reasonCode"),
        ),
      ),
    ].sort(),
  };
  return { ...body, receiptRoot: contentRoot(body) };
}

export function verifyBuildchainCompatibilityVerificationReceipt(receiptInput) {
  try {
    const receipt = clone(receiptInput || {});
    const normalized =
      receipt.schema === BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA
        ? createBuildchainCompatibilityVerificationReceipt(receipt)
        : receipt.schema ===
            BUILDCHAIN_LEGACY_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA
          ? createLegacyCompatibilityVerificationReceipt(receipt)
          : null;
    if (!normalized) return { ok: false, reason: "unsupported-schema" };
    if (normalized.receiptRoot !== receipt.receiptRoot)
      return { ok: false, reason: "receipt-root-drift" };
    if (JSON.stringify(normalized) !== JSON.stringify(receipt))
      return { ok: false, reason: "non-canonical-receipt" };
    return {
      ok: true,
      reason: "exact-compatibility-verification-receipt",
      receiptRoot: receipt.receiptRoot,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-receipt", error: error.message };
  }
}

export function contractSummary(
  contractWorld,
  runtimeRef = "",
  runtimeSha = "",
) {
  return {
    ref: runtimeRef,
    resolvedSha: runtimeSha,
    contract: contractWorld.contract,
    contractDigest: contractWorld.contractDigest,
    compatibilityDigest: contractWorld.compatibilityDigest,
    compatibilityFactRegistryRoot: contractWorld.compatibilityFactRegistryRoot,
    compatibilityFactCutRoot: contractWorld.compatibilityFactCutRoot,
    compatibilityProofRegistryRoot:
      contractWorld.compatibilityProofRegistryRoot,
    majorLine: contractWorld.majorLine,
    surfaceCount: Array.isArray(contractWorld.surfaces)
      ? contractWorld.surfaces.length
      : 0,
  };
}

function evaluationReceipt({
  status,
  compatible,
  policy,
  accepted,
  current,
  decisions = [],
  reasons = [],
}) {
  return createBuildchainCompatibilityVerificationReceipt({
    status,
    compatible,
    policy,
    scope: { contract: current.contract, majorLine: current.majorLine },
    acceptedContractDigest: accepted.contractDigest,
    acceptedCompatibilityDigest: accepted.compatibilityDigest,
    acceptedFactRegistryRoot: accepted.compatibilityFactRegistryRoot,
    acceptedProofRegistryRoot: accepted.compatibilityProofRegistryRoot,
    currentContractDigest: current.contractDigest,
    currentCompatibilityDigest: current.compatibilityDigest,
    currentFactRegistryRoot: current.compatibilityFactRegistryRoot,
    currentFactCutRoot: current.compatibilityFactCutRoot,
    currentProofRegistryRoot: current.compatibilityProofRegistryRoot,
    decisions,
    reasonCodes: reasons,
  });
}

function contractPolicyReasons(accepted, current, policy) {
  const reasons = [];
  if (accepted.contract !== current.contract)
    reasons.push(
      `contract changed from ${accepted.contract || "(unknown)"} to ${current.contract}`,
    );
  if (accepted.majorLine && accepted.majorLine !== current.majorLine)
    reasons.push(
      `major line changed from ${accepted.majorLine} to ${current.majorLine}`,
    );
  if (policy === "exact" && accepted.contractDigest !== current.contractDigest)
    reasons.push(
      "exact policy requires the contract digest to remain unchanged",
    );
  if (!["major-compatible", "allow-additive", "exact"].includes(policy))
    reasons.push(`unsupported compatibility policy: ${policy}`);
  return reasons;
}

function evaluateSurfaceRelation({
  oldSurface,
  nextSurface,
  proofRegistry,
  majorLine,
}) {
  if (!nextSurface) {
    return {
      reason: `surface removed: ${oldSurface.id}`,
      decision: {
        surfaceId: oldSurface.id,
        status: "surface-removed",
        sourceBreakingDigest: oldSurface.breakingDigest,
        targetBreakingDigest: "",
        reason: "surface-removed",
      },
    };
  }
  if (nextSurface.breakingDigest === oldSurface.breakingDigest) return {};
  const resolution = resolveBuildchainCompatibilityProof({
    registry: proofRegistry,
    surface: nextSurface,
    sourceBreakingDigest: oldSurface.breakingDigest,
    majorLine,
  });
  if (!resolution.ok) {
    return {
      reason: `surface breaking digest changed without a valid compatibility proof: ${oldSurface.id} (${resolution.reason})`,
      decision: {
        surfaceId: oldSurface.id,
        status: "rejected",
        sourceBreakingDigest: oldSurface.breakingDigest,
        targetBreakingDigest: nextSurface.breakingDigest,
        reason: resolution.reason,
      },
    };
  }
  const proof = resolution.proof;
  return {
    decision: {
      surfaceId: oldSurface.id,
      status: "accepted",
      sourceBreakingDigest: oldSurface.breakingDigest,
      targetBreakingDigest: nextSurface.breakingDigest,
      proofRoot: proof.proofRoot,
      factRoot: resolution.factRoot,
      pathReceipt: resolution.pathReceipt,
      pathReceiptRoot: resolution.pathReceiptRoot,
      direction: proof.direction,
      operation: proof.operation,
      scope: proof.scope,
      scopeRoot: proof.scopeRoot,
      evidence: proof.evidence,
      evidenceRoot: proof.evidenceRoot,
      authority: proof.authority,
      authorityRoot: proof.authorityRoot,
      cut: proof.cut,
      cutRoot: proof.cutRoot,
    },
  };
}

function evaluateChannelBinding({
  lock,
  workflowShellRef,
  runtimeRef,
  expectedChannel,
  expectedMajor,
  allowOpaqueRuntime,
}) {
  if (!workflowShellRef && !expectedChannel && !expectedMajor) return null;
  return evaluateBuildchainChannelBinding({
    workflowShellRef,
    runtimeRef,
    lockRef: lock?.buildchain?.ref || "",
    lockMajorLine: lock?.buildchain?.majorLine || "",
    expectedChannel,
    expectedMajor,
    allowOpaqueRuntime,
  });
}

export function evaluateBuildchainContractLock({
  lock,
  current,
  runtimeRef = "",
  runtimeSha = "",
  runtimeClass = "",
  compatibilityPolicy = "",
  workflowShellRef = "",
  expectedChannel = "",
  expectedMajor = "",
  allowOpaqueRuntime = false,
} = {}) {
  if (!current || current.contract !== BUILDCHAIN_CONTRACT) {
    throw new Error("current must be a Buildchain runtime contract world");
  }
  assertBuildchainCompatibilityProjection(current);
  const binding = evaluateChannelBinding({
    lock,
    workflowShellRef,
    runtimeRef,
    expectedChannel,
    expectedMajor,
    allowOpaqueRuntime,
  });
  if (binding?.ok === false) {
    return {
      ok: false,
      status: binding.status,
      drift: false,
      compatible: false,
      issueRecommended: false,
      reasons: binding.reasons,
      channelBinding: binding,
    };
  }
  if (!new Set(["stable", "alpha"]).has(runtimeClass)) {
    return {
      ok: true,
      status: "non-floating-runtime",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: `runtime class ${runtimeClass || "unknown"} is not a stable floating ref`,
    };
  }
  if (!lock) {
    return {
      ok: true,
      status: "missing-lock",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: "consumer repository has no Buildchain contract lock",
    };
  }
  const accepted = lock.buildchain || {};
  const policy =
    compatibilityPolicy || accepted.compatibilityPolicy || "major-compatible";
  const shaDrift =
    !!accepted.resolvedSha &&
    !!runtimeSha &&
    accepted.resolvedSha !== runtimeSha;
  const contractDrift =
    !!accepted.contractDigest &&
    accepted.contractDigest !== current.contractDigest;
  if (!shaDrift && !contractDrift) {
    const verificationReceipt = evaluationReceipt({
      status: "unchanged",
      compatible: true,
      policy,
      accepted,
      current,
    });
    return {
      ok: true,
      status: "unchanged",
      drift: false,
      compatible: true,
      issueRecommended: false,
      policy,
      accepted,
      current: contractSummary(current, runtimeRef, runtimeSha),
      compatibilityDecisions: [],
      usedProofRoots: [],
      usedFactRoots: [],
      pathReceiptRoots: [],
      verificationReceipt,
      receiptRoot: verificationReceipt.receiptRoot,
    };
  }
  const reasons = contractPolicyReasons(accepted, current, policy);
  const compatibilityDecisions = [];
  const currentSurfaces = new Map(
    current.surfaces.map((entry) => [entry.id, entry]),
  );
  const proofRegistry = createBuildchainCompatibilityProofRegistry({
    proofs: current.compatibilityProofs,
    surfaces: current.surfaces,
    majorLine: current.majorLine,
  });
  for (const oldSurface of accepted.surfaces || []) {
    const result = evaluateSurfaceRelation({
      oldSurface,
      nextSurface: currentSurfaces.get(oldSurface.id),
      proofRegistry,
      majorLine: current.majorLine,
    });
    if (result.reason) reasons.push(result.reason);
    if (result.decision) compatibilityDecisions.push(result.decision);
  }
  const compatible = reasons.length === 0;
  const status = compatible ? "compatible-drift" : "breaking-drift";
  const verificationReceipt = evaluationReceipt({
    status,
    compatible,
    policy,
    accepted,
    current,
    decisions: compatibilityDecisions,
    reasons,
  });
  return {
    ok: compatible,
    status,
    drift: shaDrift || contractDrift,
    shaDrift,
    contractDrift,
    compatible,
    issueRecommended: true,
    policy,
    reasons,
    accepted,
    current: contractSummary(current, runtimeRef, runtimeSha),
    compatibilityDecisions,
    usedProofRoots: verificationReceipt.usedProofRoots,
    usedFactRoots: verificationReceipt.usedFactRoots,
    pathReceiptRoots: verificationReceipt.pathReceiptRoots,
    verificationReceipt,
    receiptRoot: verificationReceipt.receiptRoot,
  };
}

function shown(value, fallback = "(unknown)") {
  return value ? value : fallback;
}

function renderCompatibilityDecision(decision) {
  const lines = [
    `- Surface \`${decision.surfaceId}\`: ${decision.status}`,
    `  - Relation: \`${shown(decision.sourceBreakingDigest, "(missing)")}\` -> \`${shown(decision.targetBreakingDigest, "(missing)")}\``,
    `  - Reason: \`${shown(decision.reason, "proof-backed-compatible-relation")}\``,
  ];
  if (!decision.proofRoot) return lines.join("\n");
  lines.push(
    `  - Proof root: \`${decision.proofRoot}\``,
    `  - Fact root: \`${decision.factRoot}\``,
    `  - Temporal path receipt: \`${decision.pathReceiptRoot}\``,
    `  - Direction / operation: \`${decision.direction}\` / \`${decision.operation}\``,
    `  - Scope root: \`${decision.scopeRoot}\``,
    `  - Evidence: ${shown(decision.evidence && decision.evidence.pullRequest)} (\`${decision.evidenceRoot}\`)`,
    `  - Authority: \`${shown(decision.authority && decision.authority.repository)}@${shown(decision.authority && decision.authority.protectedBase)}\` (\`${decision.authorityRoot}\`)`,
    `  - Cut: \`${shown(decision.cut && decision.cut.commit)}\` (\`${decision.cutRoot}\`)`,
  );
  return lines.join("\n");
}

function renderCompatibilityDecisions(decisions) {
  if (decisions.length === 0)
    return "- No breaking-digest relation required proof resolution.";
  return decisions.map(renderCompatibilityDecision).join("\n");
}

export function renderBuildchainContractDriftIssueBody({
  repository = "",
  workflow = "",
  runUrl = "",
  lockPath = "",
  evaluation,
} = {}) {
  const accepted = evaluation.accepted || {};
  const current = evaluation.current || {};
  const decisions = evaluation.compatibilityDecisions || [];
  const renderedDecisions = renderCompatibilityDecisions(decisions);
  return [
    "# Buildchain contract drift",
    "",
    "## Summary",
    "",
    `Buildchain detected ${evaluation.compatible ? "compatible" : "breaking"} contract drift for a floating runtime ref before expensive Buildchain work continued.`,
    "",
    "## Consumer",
    "",
    `- Repository: ${shown(repository)}`,
    `- Workflow: ${shown(workflow)}`,
    `- Run: ${shown(runUrl)}`,
    `- Lock path: ${shown(lockPath)}`,
    "",
    "## Accepted Buildchain contract",
    "",
    `- Ref: ${shown(accepted.ref)}`,
    `- SHA: ${shown(accepted.resolvedSha)}`,
    `- Contract digest: ${shown(accepted.contractDigest)}`,
    `- Compatibility digest: ${shown(accepted.compatibilityDigest)}`,
    `- Compatibility Fact registry: ${shown(accepted.compatibilityFactRegistryRoot, "(legacy lock without Fact registry)")}`,
    `- Compatibility proof registry: ${shown(accepted.compatibilityProofRegistryRoot, "(legacy lock without proof registry)")}`,
    `- Policy: ${shown(evaluation.policy || accepted.compatibilityPolicy)}`,
    "",
    "## Current Buildchain contract",
    "",
    `- Ref: ${shown(current.ref)}`,
    `- SHA: ${shown(current.resolvedSha)}`,
    `- Contract digest: ${shown(current.contractDigest)}`,
    `- Compatibility digest: ${shown(current.compatibilityDigest)}`,
    `- Compatibility Fact registry: ${shown(current.compatibilityFactRegistryRoot)}`,
    `- Compatibility Fact Cut: ${shown(current.compatibilityFactCutRoot)}`,
    `- Compatibility proof registry: ${shown(current.compatibilityProofRegistryRoot)}`,
    `- Major line: ${shown(current.majorLine)}`,
    "",
    "## Compatibility",
    "",
    `- Status: ${shown(evaluation.status)}`,
    `- Compatible: ${evaluation.compatible ? "yes" : "no"}`,
    evaluation.reasons && evaluation.reasons.length
      ? evaluation.reasons.map((reason) => `- ${reason}`).join("\n")
      : "- No breaking drift detected.",
    "",
    "## Proof-backed decisions",
    "",
    renderedDecisions,
    `- Verification receipt: \`${shown(evaluation.receiptRoot, "(not produced)")}\``,
    "",
    "## Suggested next action",
    "",
    evaluation.compatible
      ? "Review the Buildchain release notes, then update the consumer contract lock to the current SHA and contract digest."
      : "Failing before heavy build is intentional. Review the Buildchain contract change, update the consumer workflow/configuration, or pin the previous Buildchain SHA.",
  ].join("\n");
}
