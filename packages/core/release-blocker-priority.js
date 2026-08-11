// SPDX-License-Identifier: Apache-2.0

import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { validateReleaseBlockerRepair } from "./release-train.js";

export const RELEASE_BLOCKER_PRIORITY_CLAIM_SCHEMA =
  "kungfu.buildchain.release-blocker-priority-claim/v1";

function exactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
}

export function createReleaseBlockerPriorityClaim(repairInput, input = {}) {
  const repair = validateReleaseBlockerRepair(repairInput);
  if (!repair.publication.eligible || repair.devLanding.status !== "landed") {
    throw new Error(
      "release-blocker priority requires an exact settled dev landing",
    );
  }
  const body = {
    schema: RELEASE_BLOCKER_PRIORITY_CLAIM_SCHEMA,
    repository: repository(repair.successorTrain.releaseCut.repository),
    protectedBase: protectedBase(repair.successorTrain.releaseCut.sourceBranch),
    assignmentRoot: exactRoot(input.assignmentRoot, "assignmentRoot"),
    initiativeRoot: exactRoot(input.initiativeRoot, "initiativeRoot"),
    repairRoot: exactRoot(repair.repairRoot, "repairRoot"),
    priorCutRoot: exactRoot(
      repair.priorTrain.releaseCut.cutRoot,
      "priorCutRoot",
    ),
    successorCutRoot: exactRoot(
      repair.successorTrain.releaseCut.cutRoot,
      "successorCutRoot",
    ),
    candidateGeneration: positiveInteger(
      repair.successorTrain.releaseCut.generation,
      "candidateGeneration",
    ),
    cutCandidateSha: exactSha(repair.cutLanding.landedSha, "cutCandidateSha"),
    sourceHead: exactSha(repair.devLanding.landedSha, "sourceHead"),
    sourcePatchRoot: exactRoot(repair.patchRoot, "sourcePatchRoot"),
    cutLandingEvidenceRoot: exactRoot(
      repair.cutLanding.evidenceRoot,
      "cutLandingEvidenceRoot",
    ),
    devLandingEvidenceRoot: exactRoot(
      repair.devLanding.evidenceRoot,
      "devLandingEvidenceRoot",
    ),
    publicationGateRoot: exactRoot(
      repair.publication.gateRoot,
      "publicationGateRoot",
    ),
    issuedAt: timestamp(input.issuedAt, "issuedAt"),
  };
  return { ...body, claimRoot: devDeliveryContentRoot(body) };
}

export function normalizeReleaseBlockerPriorityClaim(
  input,
  candidate,
  expected,
) {
  exactFields(
    input,
    [
      "schema",
      "repository",
      "protectedBase",
      "assignmentRoot",
      "initiativeRoot",
      "repairRoot",
      "priorCutRoot",
      "successorCutRoot",
      "candidateGeneration",
      "cutCandidateSha",
      "sourceHead",
      "sourcePatchRoot",
      "cutLandingEvidenceRoot",
      "devLandingEvidenceRoot",
      "publicationGateRoot",
      "issuedAt",
      "claimRoot",
    ],
    "releaseBlockerPriority",
  );
  const body = {
    schema: text(input.schema),
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    assignmentRoot: exactRoot(
      input.assignmentRoot,
      "releaseBlockerPriority.assignmentRoot",
    ),
    initiativeRoot: exactRoot(
      input.initiativeRoot,
      "releaseBlockerPriority.initiativeRoot",
    ),
    repairRoot: exactRoot(
      input.repairRoot,
      "releaseBlockerPriority.repairRoot",
    ),
    priorCutRoot: exactRoot(
      input.priorCutRoot,
      "releaseBlockerPriority.priorCutRoot",
    ),
    successorCutRoot: exactRoot(
      input.successorCutRoot,
      "releaseBlockerPriority.successorCutRoot",
    ),
    candidateGeneration: positiveInteger(
      input.candidateGeneration,
      "releaseBlockerPriority.candidateGeneration",
    ),
    cutCandidateSha: exactSha(
      input.cutCandidateSha,
      "releaseBlockerPriority.cutCandidateSha",
    ),
    sourceHead: exactSha(input.sourceHead, "releaseBlockerPriority.sourceHead"),
    sourcePatchRoot: exactRoot(
      input.sourcePatchRoot,
      "releaseBlockerPriority.sourcePatchRoot",
    ),
    cutLandingEvidenceRoot: exactRoot(
      input.cutLandingEvidenceRoot,
      "releaseBlockerPriority.cutLandingEvidenceRoot",
    ),
    devLandingEvidenceRoot: exactRoot(
      input.devLandingEvidenceRoot,
      "releaseBlockerPriority.devLandingEvidenceRoot",
    ),
    publicationGateRoot: exactRoot(
      input.publicationGateRoot,
      "releaseBlockerPriority.publicationGateRoot",
    ),
    issuedAt: timestamp(input.issuedAt, "releaseBlockerPriority.issuedAt"),
  };
  if (body.schema !== RELEASE_BLOCKER_PRIORITY_CLAIM_SCHEMA) {
    throw new Error("releaseBlockerPriority schema is unsupported");
  }
  if (input.claimRoot !== devDeliveryContentRoot(body)) {
    throw new Error("releaseBlockerPriority claimRoot drift");
  }
  if (
    body.repository !== expected.repository ||
    body.protectedBase !== expected.protectedBase
  ) {
    throw new Error("releaseBlockerPriority queue route mismatch");
  }
  if (
    body.assignmentRoot !== candidate.assignmentRoot ||
    body.initiativeRoot !== candidate.initiativeRoot
  ) {
    throw new Error("releaseBlockerPriority Work identity mismatch");
  }
  if (
    body.sourceHead !== candidate.sourceHead ||
    body.sourcePatchRoot !== candidate.sourcePatchRoot
  ) {
    throw new Error("releaseBlockerPriority source identity mismatch");
  }
  return { ...body, claimRoot: input.claimRoot };
}

export function compareReleaseBlockerPriority(left, right) {
  const leftBlocker =
    left.priority.releaseBlocker && left.candidate.priority === "ordinary";
  const rightBlocker =
    right.priority.releaseBlocker && right.candidate.priority === "ordinary";
  if (leftBlocker === rightBlocker) return 0;
  const peer = leftBlocker ? right : left;
  return peer.candidate.priority === "ordinary" ? (leftBlocker ? -1 : 1) : 0;
}
