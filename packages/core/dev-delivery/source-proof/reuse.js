import path from "node:path";
import {
  classifyDevDeliveryDelta,
  devDeliveryContentRoot,
  verifySourceQualificationProof,
} from "../dev-delivery-warrant.js";
import { validateControllerReceipt } from "../../observability/controller-evidence.js";
import { exactMergeGroupBinding } from "./replay.js";
import { sourceQualificationPredicates } from "./predicates.js";
import { readJson, exactSha, required, git } from "./io.js";
export const REUSE_DECISION_SCHEMA =
  "kungfu.buildchain.source-qualification-reuse-decision/v1";
export function rootedDecision(body) {
  return { ...body, decisionRoot: devDeliveryContentRoot(body) };
}

export function verifySourceQualificationReuse(input = {}) {
  const proof = readJson(input.sourceProofPath, "source proof");
  const receipt = readJson(input.controllerReceiptPath, "controller receipt");
  const expectedSourceSha = exactSha(input.sourceHead, "sourceHead");
  const expectedRuntimeSha = exactSha(input.runtimeSha, "runtimeSha");
  const expectedRepository = required(input.repository, "repository");
  const receiptValidation = validateControllerReceipt(receipt, {
    expectedSourceSha,
    expectedRuntimeSha,
  });
  if (
    !receiptValidation.ok ||
    !receiptValidation.qualifying ||
    receipt.controller?.id !== "source-check" ||
    receipt.source?.repository !== expectedRepository
  ) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: "producer-controller-receipt-not-qualifying",
    });
  }
  const verification = verifySourceQualificationProof(proof, {
    repository: required(input.repository, "repository"),
    protectedBase: required(input.protectedBase, "protectedBase"),
    qualifiedBase: exactSha(proof.qualifiedBase, "qualifiedBase"),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourceWorkflowRunId: Number(input.sourceWorkflowRunId),
    controllerReceiptRoot: receipt.digest,
  });
  if (!verification.ok) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: verification.reason,
      ...(verification.error ? { diagnostic: verification.error } : {}),
    });
  }
  const current = sourceQualificationPredicates({
    ...input,
    qualifiedBase: proof.qualifiedBase,
  });
  const classification = classifyDevDeliveryDelta({
    proof,
    current: { ...current, graphKnown: true, changedPaths: [] },
  });
  if (!classification.reusable) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: classification.reason,
    });
  }
  const mergeGroup = exactMergeGroupBinding({
    ...input,
    qualifiedBase: proof.qualifiedBase,
    sourcePatchRoot: proof.sourcePatchRoot,
  });
  if (!mergeGroup.ok) {
    return rootedDecision({
      schema: REUSE_DECISION_SCHEMA,
      reusable: false,
      action: "rerun-full-source-qualification",
      reason: mergeGroup.reason,
    });
  }
  return rootedDecision({
    schema: REUSE_DECISION_SCHEMA,
    reusable: true,
    action: "reuse-source-qualification",
    reason: "exact-source-proof",
    sourceProofRoot: proof.proofRoot,
    sourceWorkflowRunId: proof.sourceWorkflowRunId,
    sourceHead: proof.sourceHead,
    qualifiedBase: proof.qualifiedBase,
    currentBase: exactSha(input.currentBase, "currentBase"),
    mergeGroupHead: mergeGroup.mergeGroupHead,
    mergeGroupTree: mergeGroup.mergeGroupTree,
    mergeGroupParents: mergeGroup.parents,
    mergeGroupCompositionMode: mergeGroup.compositionMode,
    mergeGroupReplayTrees: mergeGroup.replayedCommitTrees,
    mergeGroupReplayPatchRoots: mergeGroup.replayedCommitPatchRoots,
    predicateRoots: {
      sourceIdentityRoot: proof.sourceIdentityRoot,
      sourcePatchRoot: proof.sourcePatchRoot,
      planRoot: proof.planRoot,
      closureRoot: proof.closureRoot,
      dependencyRoot: proof.dependencyRoot,
      toolchainRoot: proof.toolchainRoot,
      policyRoot: proof.policyRoot,
      requiredContextRoot: proof.requiredContextRoot,
    },
    warrantBinding: "sourceProofRoot",
    finalAuthority: "exact-merge-group-source-proof-verification",
    verifiedAt: required(input.verifiedAt, "verifiedAt"),
  });
}
