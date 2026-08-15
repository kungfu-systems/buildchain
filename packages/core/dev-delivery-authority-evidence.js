import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
} from "./dev-delivery-common.js";
import { verifySourceQualificationProof } from "./dev-delivery-proof.js";
import { verifyNativeQualificationProof } from "./dev-delivery-native-proof.js";

export const DEV_DELIVERY_BOUNDED_QUALIFICATION_CONTRACT_SCHEMA =
  "kungfu.buildchain.dev-delivery-bounded-qualification-contract/v1";
export const DEV_DELIVERY_BOUNDED_QUALIFICATION_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-bounded-qualification-receipt/v1";

function contractBody({ state, candidate, lease, sourceProof, nativeProof }) {
  return {
    schema: DEV_DELIVERY_BOUNDED_QUALIFICATION_CONTRACT_SCHEMA,
    authority: "qualification-only",
    mergeGroupAdmission: false,
    repository: state.repository,
    protectedBase: state.protectedBase,
    candidateId: candidate.candidateId,
    qualificationLeaseToken: lease.token,
    qualificationLeaseGeneration: lease.generation,
    sourceHead: candidate.sourceHead,
    sourceProofRoot: sourceProof.proofRoot,
    nativeProofRoot: nativeProof.proofRoot,
    nativeExecutionBindingRoot: nativeProof.nativeExecutionBindingRoot,
    nativeExecutionReceiptRoot: nativeProof.nativeExecutionReceiptRoot,
    nativeCommandRoot: candidate.nativeCommandContract.commandRoot,
    planRoot: candidate.planRoot,
    closureRoot: candidate.closureRoot,
    dependencyRoot: candidate.dependencyRoot,
    toolchainRoot: candidate.toolchainRoot,
    environmentRoot: candidate.environmentRoot,
    qualificationDomains: candidate.qualificationDomains || [],
    shardEvidenceRoots: candidate.shardEvidenceRoots || [],
  };
}

export function createDevDeliveryQualificationContract(input = {}) {
  const body = contractBody(input);
  return { ...body, contractRoot: devDeliveryContentRoot(body) };
}

export function verifyDevDeliveryQualificationEvidence({
  state,
  candidate,
  lease,
  sourceProof,
  nativeProof,
  qualificationContract,
}) {
  const source = verifySourceQualificationProof(sourceProof, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceHead: candidate.sourceHead,
    sourceIdentityRoot: candidate.sourceIdentityRoot,
    sourcePatchRoot: candidate.sourcePatchRoot,
    planRoot: candidate.planRoot,
    closureRoot: candidate.closureRoot,
    dependencyRoot: candidate.dependencyRoot,
    toolchainRoot: candidate.toolchainRoot,
  });
  if (!source.ok) {
    throw new Error(`source qualification proof rejected: ${source.reason}`);
  }
  if (source.proofRoot !== candidate.sourceProofRoot) {
    throw new Error("source qualification proof root does not match candidate");
  }
  const native = verifyNativeQualificationProof(nativeProof, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceHead: candidate.sourceHead,
    sourceIdentityRoot: candidate.sourceIdentityRoot,
    sourcePatchRoot: candidate.sourcePatchRoot,
    planRoot: candidate.planRoot,
    closureRoot: candidate.closureRoot,
    dependencyRoot: candidate.dependencyRoot,
    toolchainRoot: candidate.toolchainRoot,
    environmentRoot: candidate.environmentRoot,
    nativeCommandRoot: candidate.nativeCommandContract?.commandRoot,
  });
  if (!native.ok) {
    throw new Error(`native qualification proof rejected: ${native.reason}`);
  }
  const expectedShards = [
    ...(candidate.shardEvidenceRoots || []),
    nativeProof.nativeExecutionReceiptRoot,
  ].sort();
  if (
    JSON.stringify(nativeProof.shardEvidenceRoots) !==
    JSON.stringify([...new Set(expectedShards)])
  ) {
    throw new Error(
      "native qualification shard evidence does not match candidate",
    );
  }
  const expected = createDevDeliveryQualificationContract({
    state,
    candidate,
    lease,
    sourceProof,
    nativeProof,
  });
  const observed = clone(qualificationContract || {});
  if (
    JSON.stringify(observed) !== JSON.stringify(expected) ||
    observed.contractRoot !== expected.contractRoot
  ) {
    throw new Error(
      "bounded qualification contract does not match exact evidence",
    );
  }
  return {
    sourceProofRoot: source.proofRoot,
    nativeProofRoot: native.proofRoot,
    nativeExecutionBindingRoot: nativeProof.nativeExecutionBindingRoot,
    nativeExecutionReceiptRoot: nativeProof.nativeExecutionReceiptRoot,
    nativeCommandRoot: candidate.nativeCommandContract.commandRoot,
    qualificationContractRoot: expected.contractRoot,
  };
}

export function createDevDeliveryBoundedQualificationReceipt({
  state,
  candidate,
  lease,
  evidence,
  qualifiedAt,
}) {
  const receipt = {
    schema: DEV_DELIVERY_BOUNDED_QUALIFICATION_RECEIPT_SCHEMA,
    action: "qualification-completed-lease-released",
    authority: "qualification-only",
    mergeGroupAdmission: false,
    repository: state.repository,
    protectedBase: state.protectedBase,
    candidateId: candidate.candidateId,
    qualificationLeaseToken: lease.token,
    qualificationLeaseGeneration: lease.generation,
    ...evidence,
    qualifiedAt,
    expectedOldStateRoot: state.stateRoot,
    nextAction: "Wait for the single exclusive Landing Warrant.",
  };
  return { receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}
