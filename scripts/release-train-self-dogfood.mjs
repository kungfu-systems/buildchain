#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createReleaseBlockerPriorityClaim,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import { reconcileActiveReleaseTrain } from "../packages/core/dev-alpha-active-release-train.js";
import {
  createReleaseBlockerRepair,
  createReleaseTrain,
  releaseTrainRoot,
  settleReleaseBlockerDevLanding,
  transitionReleaseTrain,
} from "../packages/core/release-train.js";

export const RELEASE_TRAIN_SELF_DOGFOOD_SCHEMA =
  "kungfu-buildchain-release-train-self-dogfood/v1";

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;

function text(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sha(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!SHA.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return normalized;
}

function root(value, label) {
  const normalized = text(value, label).toLowerCase();
  if (!ROOT.test(normalized)) throw new Error(`${label} must be a sha256 root`);
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function timestamp(value, label) {
  const normalized = text(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== normalized) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return normalized;
}

function repository(value) {
  const normalized = text(value, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
    throw new Error("repository must be owner/repo");
  }
  return normalized;
}

function branch(value, label) {
  const normalized = text(value, label).replace(/^refs\/heads\//u, "");
  if (/\s/u.test(normalized))
    throw new Error(`${label} must not contain spaces`);
  return normalized;
}

function at(recordedAt, seconds) {
  return new Date(Date.parse(recordedAt) + seconds * 1000).toISOString();
}

function normalizeDelivery(input, expected) {
  const delivery = {
    pullRequestNumber: positiveInteger(
      input?.pullRequestNumber,
      "delivery.pullRequestNumber",
    ),
    baseBranch: branch(input?.baseBranch, "delivery.baseBranch"),
    headSha: sha(input?.headSha, "delivery.headSha"),
    headTreeSha: sha(input?.headTreeSha, "delivery.headTreeSha"),
    state: text(input?.state, "delivery.state"),
    reviewState: text(input?.reviewState, "delivery.reviewState"),
    reviewHeadSha: sha(input?.reviewHeadSha, "delivery.reviewHeadSha"),
    mergeSha: sha(input?.mergeSha, "delivery.mergeSha"),
    mergeTreeSha: sha(input?.mergeTreeSha, "delivery.mergeTreeSha"),
    ciHeadSha: sha(input?.ciHeadSha, "delivery.ciHeadSha"),
    ciConclusion: text(input?.ciConclusion, "delivery.ciConclusion"),
    reviewRoot: root(input?.reviewRoot, "delivery.reviewRoot"),
    ciRoot: root(input?.ciRoot, "delivery.ciRoot"),
    mergeRoot: root(input?.mergeRoot, "delivery.mergeRoot"),
    artifactRoot: root(input?.artifactRoot, "delivery.artifactRoot"),
    installedProductRoot: root(
      input?.installedProductRoot,
      "delivery.installedProductRoot",
    ),
  };
  if (delivery.baseBranch !== expected.sourceBranch) {
    throw new Error(
      "protected delivery base does not match the Release Cut source branch",
    );
  }
  if (
    delivery.state !== "MERGED" ||
    delivery.reviewState !== "APPROVED" ||
    delivery.ciConclusion !== "success"
  ) {
    throw new Error(
      "protected delivery is not merged, approved, and CI-successful",
    );
  }
  if (
    delivery.headSha !== expected.devLandingSha ||
    delivery.reviewHeadSha !== delivery.headSha
  ) {
    throw new Error(
      "protected delivery review does not bind the exact repaired head",
    );
  }
  if (
    delivery.headTreeSha !== expected.cutCandidateTreeSha ||
    delivery.mergeTreeSha !== delivery.headTreeSha
  ) {
    throw new Error(
      "protected delivery merge tree does not equal the repaired candidate tree",
    );
  }
  if (delivery.ciHeadSha !== delivery.mergeSha) {
    throw new Error(
      "protected delivery CI does not bind the merge-group result",
    );
  }
  return delivery;
}

function normalizeInput(input = {}) {
  const normalized = {
    repository: repository(input.repository),
    sourceBranch: branch(input.sourceBranch, "sourceBranch"),
    targetBranch: branch(input.targetBranch, "targetBranch"),
    assignmentRoot: root(input.assignmentRoot, "assignmentRoot"),
    initiativeRoot: root(input.initiativeRoot, "initiativeRoot"),
    dependencyProofRoot: root(input.dependencyProofRoot, "dependencyProofRoot"),
    originDevSha: sha(input.originDevSha, "originDevSha"),
    candidateSha: sha(input.candidateSha, "candidateSha"),
    candidateTreeSha: sha(input.candidateTreeSha, "candidateTreeSha"),
    alphaBaseSha: sha(input.alphaBaseSha, "alphaBaseSha"),
    buildchainRuntimeSha: sha(
      input.buildchainRuntimeSha,
      "buildchainRuntimeSha",
    ),
    observedDevSha: sha(input.observedDevSha, "observedDevSha"),
    blockerRoot: root(input.blockerRoot, "blockerRoot"),
    patchRoot: root(input.patchRoot, "patchRoot"),
    cutCandidateSha: sha(input.cutCandidateSha, "cutCandidateSha"),
    cutCandidateTreeSha: sha(input.cutCandidateTreeSha, "cutCandidateTreeSha"),
    cutLandingEvidenceRoot: root(
      input.cutLandingEvidenceRoot,
      "cutLandingEvidenceRoot",
    ),
    devBaseSha: sha(input.devBaseSha, "devBaseSha"),
    devLandingSha: sha(input.devLandingSha, "devLandingSha"),
    devConflictEvidenceRoot: root(
      input.devConflictEvidenceRoot,
      "devConflictEvidenceRoot",
    ),
    devLandingEvidenceRoot: root(
      input.devLandingEvidenceRoot,
      "devLandingEvidenceRoot",
    ),
    ordinaryPullRequestNumber: positiveInteger(
      input.ordinaryPullRequestNumber,
      "ordinaryPullRequestNumber",
    ),
    recordedAt: timestamp(input.recordedAt, "recordedAt"),
  };
  if (normalized.observedDevSha === normalized.originDevSha) {
    throw new Error(
      "self-dogfood requires dev to advance beyond the frozen origin",
    );
  }
  if (normalized.cutCandidateSha === normalized.candidateSha) {
    throw new Error("self-dogfood requires a successor repair candidate");
  }
  normalized.delivery = normalizeDelivery(input.delivery, normalized);
  return normalized;
}

function deliveryCandidate(input, deliveryClass = "release") {
  return {
    pullRequestNumber: input.pullRequestNumber,
    sourceHead: input.sourceHead,
    assignmentRoot: input.assignmentRoot,
    initiativeRoot: input.initiativeRoot,
    sourceIdentityRoot: input.sourceIdentityRoot,
    sourcePatchRoot: input.sourcePatchRoot,
    sourceProofRoot: input.sourceProofRoot,
    planRoot: input.planRoot,
    closureRoot: input.closureRoot,
    dependencyRoot: input.dependencyRoot,
    toolchainRoot: input.toolchainRoot,
    deliveryClass,
    priority: "ordinary",
    ...(input.releaseBlockerPriority
      ? { releaseBlockerPriority: input.releaseBlockerPriority }
      : {}),
  };
}

function captureExpectedError(run, pattern, label) {
  try {
    run();
  } catch (error) {
    const message = String(error?.message || error);
    if (!pattern.test(message)) throw error;
    return message;
  }
  throw new Error(`${label} did not fail closed`);
}

function runTrainCampaign(value, authorityRoots) {
  let train = createReleaseTrain({
    repository: value.repository,
    sourceBranch: value.sourceBranch,
    targetBranch: value.targetBranch,
    originDevSha: value.originDevSha,
    candidateSha: value.candidateSha,
    candidateTreeSha: value.candidateTreeSha,
    alphaBaseSha: value.alphaBaseSha,
    buildchainRuntimeSha: value.buildchainRuntimeSha,
    authorityRoots,
    createdAt: value.recordedAt,
  });
  train = transitionReleaseTrain(train, {
    to: "building",
    expectedStateRoot: train.state.stateRoot,
    event: "self-dogfood-build-started",
    reason: "the frozen Buildchain candidate entered its protected campaign",
    authorityRoots: [value.dependencyProofRoot],
    recordedAt: at(value.recordedAt, 1),
  });
  train = transitionReleaseTrain(train, {
    to: "repair-required",
    expectedStateRoot: train.state.stateRoot,
    event: "self-dogfood-build-failed",
    reason: "the injected deterministic build failure requires a rooted repair",
    authorityRoots: [value.blockerRoot],
    recordedAt: at(value.recordedAt, 2),
  });

  const reconciliation = reconcileActiveReleaseTrain({
    releaseTrain: train,
    repository: value.repository,
    sourceBranch: value.sourceBranch,
    targetBranch: value.targetBranch,
    activeCandidateSha: value.candidateSha,
    sourceLockSha: value.candidateSha,
    candidateTreeSha: value.candidateTreeSha,
    alphaBaseSha: value.alphaBaseSha,
    buildchainRuntimeSha: value.buildchainRuntimeSha,
    observedDevSha: value.observedDevSha,
    observedAt: at(value.recordedAt, 3),
  });
  if (reconciliation.status !== "active" || !reconciliation.drift.moved) {
    throw new Error("the frozen candidate did not survive moving dev");
  }

  const invalidAuthority = reconcileActiveReleaseTrain({
    releaseTrain: train,
    repository: "invalid-authority/buildchain",
    sourceBranch: value.sourceBranch,
    targetBranch: value.targetBranch,
    activeCandidateSha: value.candidateSha,
    sourceLockSha: value.candidateSha,
    candidateTreeSha: value.candidateTreeSha,
    alphaBaseSha: value.alphaBaseSha,
    buildchainRuntimeSha: value.buildchainRuntimeSha,
    observedDevSha: value.observedDevSha,
    observedAt: at(value.recordedAt, 3),
  });
  if (
    invalidAuthority.status !== "held" ||
    invalidAuthority.hold?.code !== "invalid-authority"
  ) {
    throw new Error("invalid authority did not fail closed");
  }

  const conflicted = createReleaseBlockerRepair(reconciliation.train, {
    expectedStateRoot: reconciliation.train.state.stateRoot,
    blockerRoot: value.blockerRoot,
    patchRoot: value.patchRoot,
    cutCandidateSha: value.cutCandidateSha,
    cutCandidateTreeSha: value.cutCandidateTreeSha,
    cutPatchRoot: value.patchRoot,
    cutLandingEvidenceRoot: value.cutLandingEvidenceRoot,
    devLandingStatus: "conflict",
    devBaseSha: value.devBaseSha,
    devLandingSha: "",
    devPatchRoot: value.patchRoot,
    devLandingEvidenceRoot: value.devConflictEvidenceRoot,
    authorityRoots,
    createdAt: at(value.recordedAt, 4),
  });
  if (conflicted.publication.eligible || !conflicted.candidateBuild.eligible) {
    throw new Error(
      "dev conflict did not block publication independently of build",
    );
  }
  const repaired = settleReleaseBlockerDevLanding(conflicted, {
    expectedRepairRoot: conflicted.repairRoot,
    devBaseSha: value.devBaseSha,
    devLandingSha: value.devLandingSha,
    patchRoot: value.patchRoot,
    devLandingEvidenceRoot: value.devLandingEvidenceRoot,
  });
  if (!repaired.publication.eligible) {
    throw new Error("settled dual landing did not open publication");
  }
  const priorityClaim = createReleaseBlockerPriorityClaim(repaired, {
    assignmentRoot: value.assignmentRoot,
    initiativeRoot: value.initiativeRoot,
    issuedAt: at(value.recordedAt, 5),
  });
  return {
    reconciliation,
    invalidAuthority,
    conflicted,
    repaired,
    priorityClaim,
  };
}

function runQueueCampaign(value, repaired, priorityClaim) {
  let queue = createDevDeliveryQueue({
    repository: value.repository,
    protectedBase: value.sourceBranch,
    policy: { agingSeconds: 300, leaseSeconds: 600 },
    now: at(value.recordedAt, 6),
  });
  const ordinary = deliveryCandidate(
    {
      pullRequestNumber: value.ordinaryPullRequestNumber,
      sourceHead: value.originDevSha,
      assignmentRoot: value.dependencyProofRoot,
      initiativeRoot: value.initiativeRoot,
      sourceIdentityRoot: value.dependencyProofRoot,
      sourcePatchRoot: value.dependencyProofRoot,
      sourceProofRoot: value.dependencyProofRoot,
      planRoot: value.dependencyProofRoot,
      closureRoot: value.dependencyProofRoot,
      dependencyRoot: value.dependencyProofRoot,
      toolchainRoot: value.dependencyProofRoot,
    },
    "native-proof-required",
  );
  queue = submitDevDeliveryCandidate(queue, ordinary, {
    now: at(value.recordedAt, 6),
  }).queue;
  const activeOrdinary = selectDevDeliveryWarrant(queue, {
    now: at(value.recordedAt, 7),
  });
  queue = activeOrdinary.queue;

  const blocker = deliveryCandidate({
    pullRequestNumber: value.delivery.pullRequestNumber,
    sourceHead: value.devLandingSha,
    assignmentRoot: value.assignmentRoot,
    initiativeRoot: value.initiativeRoot,
    sourceIdentityRoot: repaired.successorTrain.releaseCut.cutRoot,
    sourcePatchRoot: value.patchRoot,
    sourceProofRoot: value.delivery.ciRoot,
    planRoot: repaired.repairRoot,
    closureRoot: value.delivery.mergeRoot,
    dependencyRoot: value.dependencyProofRoot,
    toolchainRoot: value.delivery.installedProductRoot,
    releaseBlockerPriority: priorityClaim,
  });
  const submitted = submitDevDeliveryCandidate(queue, blocker, {
    now: at(value.recordedAt, 8),
  });
  queue = submitted.queue;
  const duplicate = submitDevDeliveryCandidate(queue, blocker, {
    now: at(value.recordedAt, 9),
  });
  if (duplicate.receipt.action !== "duplicate-noop") {
    throw new Error("duplicate delivery event was not idempotent");
  }
  queue = duplicate.queue;
  const retained = selectDevDeliveryWarrant(queue, {
    now: at(value.recordedAt, 10),
  });
  if (
    retained.receipt.reason !== "non-preemptive-active-warrant" ||
    retained.warrant.pullRequestNumber !== value.ordinaryPullRequestNumber
  ) {
    throw new Error("release-blocker priority preempted an active Warrant");
  }
  queue = closeDevDeliveryWarrant(retained.queue, retained.warrant, {
    outcome: "merged",
    evidenceRoot: value.dependencyProofRoot,
    now: at(value.recordedAt, 11),
  }).queue;
  const selected = selectDevDeliveryWarrant(queue, {
    now: at(value.recordedAt, 12),
  });
  if (
    selected.receipt.reason !== "release-blocker-bounded-priority" ||
    selected.warrant.pullRequestNumber !== value.delivery.pullRequestNumber
  ) {
    throw new Error(
      "eligible release blocker did not receive bounded priority",
    );
  }
  const closed = closeDevDeliveryWarrant(selected.queue, selected.warrant, {
    outcome: "merged",
    evidenceRoot: value.delivery.mergeRoot,
    now: at(value.recordedAt, 13),
  });

  const unrelatedPriorityError = captureExpectedError(
    () =>
      submitDevDeliveryCandidate(
        createDevDeliveryQueue({
          repository: value.repository,
          protectedBase: value.sourceBranch,
          now: at(value.recordedAt, 14),
        }),
        { ...blocker, sourceHead: value.originDevSha },
        { now: at(value.recordedAt, 14) },
      ),
    /source identity mismatch/u,
    "unrelated release-blocker priority",
  );
  return {
    submitted,
    duplicate,
    retained,
    selected,
    closed,
    unrelatedPriorityError,
  };
}

export function runReleaseTrainSelfDogfoodCampaign(input = {}) {
  const value = normalizeInput(input);
  const authorityRoots = [
    value.assignmentRoot,
    value.dependencyProofRoot,
    value.initiativeRoot,
  ].sort();
  const {
    reconciliation,
    invalidAuthority,
    conflicted,
    repaired,
    priorityClaim,
  } = runTrainCampaign(value, authorityRoots);
  const {
    submitted,
    duplicate,
    retained,
    selected,
    closed,
    unrelatedPriorityError,
  } = runQueueCampaign(value, repaired, priorityClaim);

  const body = {
    schema: RELEASE_TRAIN_SELF_DOGFOOD_SCHEMA,
    status: "passed",
    input: value,
    train: {
      trainRoot: reconciliation.train.trainRoot,
      cutRoot: reconciliation.train.releaseCut.cutRoot,
      stateRoot: reconciliation.train.state.stateRoot,
      candidateSha: reconciliation.train.releaseCut.candidateSha,
      observedDevSha: value.observedDevSha,
      movingDevObservationRoot: reconciliation.drift.observationRoot,
    },
    repair: {
      conflictedRepairRoot: conflicted.repairRoot,
      successorRepairRoot: repaired.repairRoot,
      successorCutRoot: repaired.successorTrain.releaseCut.cutRoot,
      successorGeneration: repaired.successorTrain.releaseCut.generation,
      patchRoot: repaired.patchRoot,
      conflictPublicationGateRoot: conflicted.publication.gateRoot,
      publicationGateRoot: repaired.publication.gateRoot,
      priorityClaimRoot: priorityClaim.claimRoot,
    },
    queue: {
      blockerSubmissionReceiptRoot: submitted.receiptRoot,
      duplicateAction: duplicate.receipt.action,
      retainedWarrantReceiptRoot: retained.receiptRoot,
      blockerSelectionReceiptRoot: selected.receiptRoot,
      terminalReceiptRoot: closed.receiptRoot,
      terminalStateRoot: closed.queue.stateRoot,
    },
    negativeCases: {
      invalidAuthorityHoldRoot: invalidAuthority.hold.holdRoot,
      unrelatedPriorityError,
    },
    protectedDelivery: value.delivery,
    assertions: {
      frozenCandidateSurvivedMovingDev: true,
      successorRepairAdvancedGeneration: true,
      devConflictBlockedOnlyPublication: true,
      exactPatchDualLandingOpenedPublication: true,
      activeWarrantWasNotPreempted: true,
      eligibleBlockerReceivedBoundedPriority: true,
      duplicateEventWasNoop: true,
      invalidAuthorityFailedClosed: true,
      unrelatedPriorityFailedClosed: true,
      protectedDeliveryReadbackComplete: true,
    },
    recordedAt: at(value.recordedAt, 15),
  };
  return { ...body, campaignRoot: releaseTrainRoot(body) };
}

export function validateReleaseTrainSelfDogfoodCampaign(report) {
  if (report?.schema !== RELEASE_TRAIN_SELF_DOGFOOD_SCHEMA) {
    throw new Error("self-dogfood campaign schema is unsupported");
  }
  const rebuilt = runReleaseTrainSelfDogfoodCampaign(report.input);
  if (report.campaignRoot !== rebuilt.campaignRoot) {
    throw new Error("self-dogfood campaign root drift");
  }
  if (releaseTrainRoot(report) !== releaseTrainRoot(rebuilt)) {
    throw new Error("self-dogfood campaign content drift");
  }
  return structuredClone(report);
}

function parseArguments(argv) {
  const options = { input: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" || argument === "--output") {
      options[argument.slice(2)] = text(argv[index + 1], argument);
      index += 1;
    } else {
      throw new Error(`unsupported argument: ${argument}`);
    }
  }
  if (!options.input) throw new Error("--input is required");
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const input = JSON.parse(fs.readFileSync(options.input, "utf8"));
  const report = runReleaseTrainSelfDogfoodCampaign(input);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) fs.writeFileSync(options.output, output);
  process.stdout.write(output);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
