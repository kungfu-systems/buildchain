import { devDeliveryClone as clone, devDeliveryContentRoot, devDeliveryExactRoot as exactRoot, devDeliveryExactSha as exactSha, devDeliveryPositiveInteger as positiveInteger, devDeliveryProtectedBase as protectedBase, devDeliveryRepository as repository, devDeliveryText as text, devDeliveryTimestamp as timestamp } from "./dev-delivery-common.js";

export const SOURCE_QUALIFICATION_PROOF_SCHEMA = "kungfu.buildchain.source-qualification-proof/v1";
export const SOURCE_QUALIFICATION_PROOF_V2_SCHEMA = "kungfu.buildchain.source-qualification-proof/v2";
export const PROJECT_CUT_REPLAY_PROOF_SCHEMA = "kungfu.buildchain.project-cut-replay-proof/v1";
export const INTEGRATION_DELIVERY_PROOF_SCHEMA = "kungfu.buildchain.integration-delivery-proof/v1";

const SOURCE_QUALIFICATION_ROOT_SEMANTICS = "qualification-identity-v1";

const DEV_DELIVERY_WARRANT_SCHEMA = "kungfu.buildchain.dev-delivery-warrant/v1";

function exactRoots(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must contain at least one content root`);
  return [...new Set(values.map((value) => exactRoot(value, label)))].sort();
}

function rootedProof(body) {
  return { ...body, proofRoot: devDeliveryContentRoot(body) };
}

function sourceQualificationIdentity(body) {
  const identity = clone(body);
  delete identity.qualifiedAt;
  delete identity.observationRoot;
  return identity;
}

function sourceQualificationObservation(body) {
  return { qualifiedAt: body.qualifiedAt };
}

export function createSourceQualificationProof(input = {}) {
  const body = {
    schema: SOURCE_QUALIFICATION_PROOF_SCHEMA,
    rootSemantics: SOURCE_QUALIFICATION_ROOT_SEMANTICS,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceIdentityRoot: exactRoot(input.sourceIdentityRoot, "sourceIdentityRoot"),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    affectedPaths: [...new Set((input.affectedPaths || []).map(text).filter(Boolean))].sort(),
    shardEvidenceRoots: exactRoots(input.shardEvidenceRoots, "shardEvidenceRoots"),
    qualifiedAt: timestamp(input.qualifiedAt, "qualifiedAt"),
  };
  body.observationRoot = devDeliveryContentRoot(sourceQualificationObservation(body));
  return { ...body, proofRoot: devDeliveryContentRoot(sourceQualificationIdentity(body)) };
}

export function createSourceQualificationProofV2(input = {}) {
  const body = {
    schema: SOURCE_QUALIFICATION_PROOF_V2_SCHEMA,
    rootSemantics: SOURCE_QUALIFICATION_ROOT_SEMANTICS,
    authority: "exact-source-qualification",
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    qualifiedBase: exactSha(input.qualifiedBase, "qualifiedBase"),
    sourceIdentityRoot: exactRoot(input.sourceIdentityRoot, "sourceIdentityRoot"),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourceTree: exactSha(input.sourceTree, "sourceTree"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    policyRoot: exactRoot(input.policyRoot, "policyRoot"),
    requiredContextRoot: exactRoot(input.requiredContextRoot, "requiredContextRoot"),
    controllerReceiptRoot: exactRoot(input.controllerReceiptRoot, "controllerReceiptRoot"),
    sourceWorkflowRunId: positiveInteger(input.sourceWorkflowRunId, "sourceWorkflowRunId"),
    affectedPaths: [...new Set((input.affectedPaths || []).map(text).filter(Boolean))].sort(),
    shardEvidenceRoots: exactRoots(input.shardEvidenceRoots, "shardEvidenceRoots"),
    qualifiedAt: timestamp(input.qualifiedAt, "qualifiedAt"),
  };
  body.observationRoot = devDeliveryContentRoot(sourceQualificationObservation(body));
  return { ...body, proofRoot: devDeliveryContentRoot(sourceQualificationIdentity(body)) };
}

export function verifySourceQualificationProof(proofInput, expected = {}) {
  try {
    const proof = clone(proofInput || {});
    if (![SOURCE_QUALIFICATION_PROOF_SCHEMA, SOURCE_QUALIFICATION_PROOF_V2_SCHEMA].includes(proof.schema)) return { ok: false, reason: "unsupported-schema" };
    const proofRoot = proof.proofRoot;
    delete proof.proofRoot;
    if (proof.rootSemantics === undefined) {
      if (devDeliveryContentRoot(proof) !== proofRoot) return { ok: false, reason: "proof-root-drift" };
    } else {
      if (proof.rootSemantics !== SOURCE_QUALIFICATION_ROOT_SEMANTICS) return { ok: false, reason: "unsupported-root-semantics" };
      if (devDeliveryContentRoot(sourceQualificationIdentity(proof)) !== proofRoot) return { ok: false, reason: "proof-root-drift" };
      if (devDeliveryContentRoot(sourceQualificationObservation(proof)) !== proof.observationRoot) return { ok: false, reason: "observation-root-drift" };
    }
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && proof[field] !== value) return { ok: false, reason: `${field}-mismatch` };
    }
    if (proof.schema === SOURCE_QUALIFICATION_PROOF_V2_SCHEMA) {
      if (proof.authority !== "exact-source-qualification") return { ok: false, reason: "non-exact-authority" };
      createSourceQualificationProofV2(proof);
    } else {
      createSourceQualificationProof(proof);
    }
    return { ok: true, reason: "exact-source-proof", proofRoot };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
}

export function classifyDevDeliveryDelta({ proof, current = {} } = {}) {
  const verification = verifySourceQualificationProof(proof);
  if (!verification.ok)
    return {
      action: "rerun-full-source-qualification",
      reason: verification.reason,
      reusable: false,
    };
  const exactPredicates = ["sourceIdentityRoot", "sourcePatchRoot", "planRoot", "closureRoot", "dependencyRoot", "toolchainRoot", ...(proof.schema === SOURCE_QUALIFICATION_PROOF_V2_SCHEMA ? ["qualifiedBase", "sourceHead", "sourceTree", "policyRoot", "requiredContextRoot"] : [])];
  for (const field of exactPredicates) {
    if (!current[field] || current[field] !== proof[field]) {
      return {
        action: "rerun-full-source-qualification",
        reason: `${field}-changed-or-unknown`,
        reusable: false,
      };
    }
  }
  if (current.graphKnown !== true || !Array.isArray(current.changedPaths)) {
    return {
      action: "rerun-full-source-qualification",
      reason: "dependency-attribution-unknown",
      reusable: false,
    };
  }
  const affected = new Set(proof.affectedPaths || []);
  const overlap = [...new Set(current.changedPaths.map(text).filter((entry) => affected.has(entry)))].sort();
  if (overlap.length > 0) {
    return {
      action: "rerun-affected-source-shards",
      reason: "dev-delta-overlaps-affected-closure",
      reusable: false,
      overlappingPaths: overlap,
      requiredFinalGate: "exact-integration-delivery-proof",
    };
  }
  return {
    action: "reuse-source-qualification",
    reason: "unrelated-dev-delta",
    reusable: true,
    proofRoot: proof.proofRoot,
    requiredReplay: "cheap-project-cut-replay",
    requiredFinalGate: "exact-integration-delivery-proof",
  };
}

export function createProjectCutReplayPlan(input = {}) {
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const previousBase = exactSha(input.previousBase, "previousBase");
  const currentBase = exactSha(input.currentBase, "currentBase");
  return rootedProof({
    schema: "kungfu.buildchain.project-cut-replay-plan/v1",
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    pullRequestNumber: positiveInteger(input.pullRequestNumber, "pullRequestNumber"),
    sourceHead,
    previousBase,
    currentBase,
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    replayTree: exactSha(input.replayTree, "replayTree"),
    sourceHeadMutationRequired: false,
    action: previousBase === currentBase ? "verify-existing-replay" : "replay-on-latest-base",
    finalAuthority: "github-merge-group",
  });
}

export function createProjectCutReplayProof(input = {}) {
  const qualification = input.qualificationReceipt || input.qualification || {};
  if (qualification.schema !== "project.cut.merge-queue-admission/v1") throw new Error("Project Cut qualification schema is invalid");
  if (qualification.ok !== true || qualification.decision !== "qualified") throw new Error("Project Cut qualification is not qualified");
  if (!Array.isArray(qualification.reasonCodes) || qualification.reasonCodes.length !== 0) throw new Error("Project Cut qualification retains failure reasons");
  if (typeof qualification.compositionChanged !== "boolean") throw new Error("Project Cut qualification compositionChanged is invalid");
  if (!qualification.compositionChanged && qualification.compositionRoot != null) throw new Error("unchanged Project Cut qualification must not claim a compositionRoot");
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const currentBase = exactSha(input.currentBase, "currentBase");
  const replayTree = exactSha(input.replayTree, "replayTree");
  if (exactSha(qualification.baseCommitOid, "qualification.baseCommitOid") !== currentBase) throw new Error("Project Cut qualification base does not match currentBase");
  if (exactSha(qualification.headCommitOid, "qualification.headCommitOid") !== sourceHead) throw new Error("Project Cut qualification head does not match sourceHead");
  if (exactSha(qualification.candidateTreeOid, "qualification.candidateTreeOid") !== replayTree) throw new Error("Project Cut qualification tree does not match replayTree");
  const normalizedQualification = {
    schema: qualification.schema,
    ok: true,
    decision: "qualified",
    baseCommitOid: currentBase,
    headCommitOid: sourceHead,
    candidateCommitOid: exactSha(qualification.candidateCommitOid, "qualification.candidateCommitOid"),
    candidateTreeOid: replayTree,
    replayedCommitCount: positiveInteger(qualification.replayedCommitCount, "qualification.replayedCommitCount"),
    compositionChanged: Boolean(qualification.compositionChanged),
    compositionRoot: qualification.compositionChanged
      ? exactRoot(qualification.compositionRoot, "qualification.compositionRoot")
      : null,
    reasonCodes: [],
  };
  return rootedProof({
    schema: PROJECT_CUT_REPLAY_PROOF_SCHEMA,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    pullRequestNumber: positiveInteger(input.pullRequestNumber, "pullRequestNumber"),
    sourceHead,
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    currentBase,
    replayTree,
    qualification: normalizedQualification,
    qualificationRoot: devDeliveryContentRoot(normalizedQualification),
    requiredContextRoots: exactRoots(input.requiredContextRoots, "requiredContextRoots"),
    verifiedAt: timestamp(input.verifiedAt, "verifiedAt"),
    sourceHeadMutationRequired: false,
    finalAuthority: "exact-project-cut-replay",
  });
}

export function verifyProjectCutReplayProof(proofInput, expected = {}) {
  try {
    const proof = clone(proofInput || {});
    if (proof.schema !== PROJECT_CUT_REPLAY_PROOF_SCHEMA) return { ok: false, reason: "unsupported-schema" };
    const proofRoot = proof.proofRoot;
    delete proof.proofRoot;
    if (devDeliveryContentRoot(proof) !== proofRoot) return { ok: false, reason: "proof-root-drift" };
    if (devDeliveryContentRoot(proof.qualification) !== proof.qualificationRoot) return { ok: false, reason: "qualification-root-drift" };
    if (proof.finalAuthority !== "exact-project-cut-replay") return { ok: false, reason: "non-exact-final-authority" };
    if (proof.sourceHeadMutationRequired !== false) return { ok: false, reason: "source-head-mutation-required" };
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && proof[field] !== value) return { ok: false, reason: `${field}-mismatch` };
    }
    createProjectCutReplayProof(proof);
    return { ok: true, reason: "exact-project-cut-replay", proofRoot };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
}

export function createIntegrationDeliveryProof(input = {}) {
  const warrant = input.warrant || {};
  if (warrant.schema !== DEV_DELIVERY_WARRANT_SCHEMA) throw new Error("integration proof requires a Delivery Warrant");
  return rootedProof({
    schema: INTEGRATION_DELIVERY_PROOF_SCHEMA,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceProofRoot: exactRoot(input.sourceProofRoot, "sourceProofRoot"),
    currentBase: exactSha(input.currentBase, "currentBase"),
    replayTree: exactSha(input.replayTree, "replayTree"),
    mergeGroupHead: exactSha(input.mergeGroupHead, "mergeGroupHead"),
    mergeGroupTree: exactSha(input.mergeGroupTree, "mergeGroupTree"),
    warrantCandidateId: exactRoot(warrant.candidateId, "Warrant candidateId"),
    warrantFencingToken: exactRoot(warrant.fencingToken, "Warrant fencingToken"),
    warrantGeneration: positiveInteger(warrant.generation, "Warrant generation"),
    requiredContextRoots: exactRoots(input.requiredContextRoots, "requiredContextRoots"),
    verifiedAt: timestamp(input.verifiedAt, "verifiedAt"),
    finalAuthority: "exact-github-merge-group",
  });
}

export function verifyIntegrationDeliveryProof(proofInput, expected = {}) {
  try {
    const proof = clone(proofInput || {});
    if (proof.schema !== INTEGRATION_DELIVERY_PROOF_SCHEMA) return { ok: false, reason: "unsupported-schema" };
    const proofRoot = proof.proofRoot;
    delete proof.proofRoot;
    if (devDeliveryContentRoot(proof) !== proofRoot) return { ok: false, reason: "proof-root-drift" };
    if (proof.finalAuthority !== "exact-github-merge-group") return { ok: false, reason: "non-exact-final-authority" };
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && proof[field] !== value) return { ok: false, reason: `${field}-mismatch` };
    }
    createIntegrationDeliveryProof({
      ...proof,
      warrant: {
        schema: DEV_DELIVERY_WARRANT_SCHEMA,
        candidateId: proof.warrantCandidateId,
        fencingToken: proof.warrantFencingToken,
        generation: proof.warrantGeneration,
      },
    });
    return { ok: true, reason: "exact-integration-proof", proofRoot };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
}
