// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import {
  createReleaseTrain,
  observeReleaseTrain,
  validateReleaseTrain,
} from "./release-train.js";

export const RELEASE_TRAIN_HOLD_SCHEMA =
  "kungfu-buildchain-release-train-hold/v1";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function evidenceRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function sameHold(left, right) {
  return (
    left?.schema === RELEASE_TRAIN_HOLD_SCHEMA &&
    right?.schema === RELEASE_TRAIN_HOLD_SCHEMA &&
    left.trainRoot === right.trainRoot &&
    left.code === right.code &&
    left.observedDevSha === right.observedDevSha &&
    left.observedCandidateSha === right.observedCandidateSha &&
    left.observedCandidateTreeSha === right.observedCandidateTreeSha &&
    left.observedAlphaBaseSha === right.observedAlphaBaseSha &&
    left.observedRuntimeSha === right.observedRuntimeSha
  );
}

function releaseTrainHold({
  train,
  code,
  reason,
  observedDevSha,
  observedCandidateSha,
  observedCandidateTreeSha,
  observedAlphaBaseSha,
  observedRuntimeSha,
  recordedAt,
  priorHold,
}) {
  const body = {
    schema: RELEASE_TRAIN_HOLD_SCHEMA,
    trainRoot: train.trainRoot,
    cutRoot: train.releaseCut.cutRoot,
    generation: train.releaseCut.generation,
    candidateSha: train.releaseCut.candidateSha,
    candidateTreeSha: train.releaseCut.candidateTreeSha,
    code,
    reason,
    observedDevSha,
    observedCandidateSha,
    observedCandidateTreeSha,
    observedAlphaBaseSha,
    observedRuntimeSha,
    recordedAt,
  };
  if (sameHold(priorHold, body)) return priorHold;
  return { ...body, holdRoot: evidenceRoot(body) };
}

export function observeDevOnce(train, observedDevSha, observedAt) {
  if (
    train.observations.some(
      (observation) => observation.observedDevSha === observedDevSha,
    )
  ) {
    return train;
  }
  return observeReleaseTrain(train, { observedDevSha, observedAt });
}

export async function resolveManagedCandidate({
  client,
  targetBranch,
  repository,
  sourceBranch,
  parseCandidate,
}) {
  const openPullRequests = await client.listOpenPullRequests(targetBranch);
  const managed = openPullRequests
    .map((pullRequest) => parseCandidate(pullRequest, targetBranch))
    .filter(Boolean);
  for (const candidate of managed) {
    if (
      candidate.state &&
      (candidate.state.repository !== repository ||
        candidate.state.sourceBranch !== sourceBranch)
    ) {
      throw new Error(
        `candidate PR #${candidate.number} state does not bind ${repository} ${sourceBranch}`,
      );
    }
  }
  if (managed.length > 1) {
    throw new Error(
      `multiple open Buildchain candidate PRs target ${targetBranch}: ${managed
        .map((candidate) => `#${candidate.number}`)
        .join(", ")}`,
    );
  }
  return managed[0] || null;
}

export async function cutInitialReleaseTrain({
  options,
  client,
  decision,
  candidate,
  sourceSha,
  targetSha,
  observedSourceHeadSha,
}) {
  if (!candidate) return null;
  if (!options.buildchainRuntimeSha) {
    throw new Error(
      "buildchainRuntimeSha is required to cut an active Release Train",
    );
  }
  if (!client.resolveCommitTreeSha) {
    throw new Error(
      "active Release Train creation requires candidate tree readback",
    );
  }
  const candidateTreeSha = await client.resolveCommitTreeSha(sourceSha);
  let train = createReleaseTrain({
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    originDevSha: sourceSha,
    candidateSha: sourceSha,
    candidateTreeSha,
    alphaBaseSha: targetSha,
    buildchainRuntimeSha: options.buildchainRuntimeSha,
    generation: 1,
    authorityRoots: [decision.decisionRoot, candidate.qualificationRoot].sort(),
    createdAt: options.cutCreatedAt || options.now,
  });
  train = observeDevOnce(train, observedSourceHeadSha, options.now);
  if (
    options.expectedCutRoot &&
    train.releaseCut.cutRoot !== options.expectedCutRoot
  ) {
    throw new Error(
      `Release Cut changed between observation and settlement: expected ${options.expectedCutRoot}, observed ${train.releaseCut.cutRoot}`,
    );
  }
  return train;
}

export function reconcileActiveReleaseTrain({
  releaseTrain,
  repository,
  sourceBranch,
  targetBranch,
  activeCandidateSha,
  sourceLockSha,
  candidateTreeSha,
  alphaBaseSha,
  buildchainRuntimeSha,
  observedDevSha,
  observedAt,
  priorHold = null,
}) {
  const train = observeDevOnce(
    validateReleaseTrain(releaseTrain),
    observedDevSha,
    observedAt,
  );
  if (train.state.status === "superseded") {
    return { status: "superseded", train, hold: null };
  }
  const cut = train.releaseCut;
  const checks = [
    [
      cut.repository !== repository ||
        cut.sourceBranch !== sourceBranch ||
        cut.targetBranch !== targetBranch,
      "invalid-authority",
      "the active Release Cut route no longer matches the controller route",
    ],
    [
      activeCandidateSha !== cut.candidateSha ||
        sourceLockSha !== cut.candidateSha,
      "candidate-ref-drift",
      "the managed candidate PR or source-lock ref drifted from the frozen candidate",
    ],
    [
      candidateTreeSha !== cut.candidateTreeSha,
      "candidate-tree-drift",
      "the frozen candidate tree readback does not match the Release Cut",
    ],
    [
      alphaBaseSha !== cut.alphaBaseSha,
      "alpha-base-drift",
      "the Alpha base moved after the Release Cut and requires explicit supersession or repair",
    ],
    [
      buildchainRuntimeSha !== cut.buildchainRuntimeSha,
      "runtime-drift",
      "the Buildchain runtime moved after the Release Cut and requires explicit supersession or repair",
    ],
  ];
  const failure = checks.find(([failed]) => failed);
  if (failure) {
    const [, code, reason] = failure;
    return {
      status: "held",
      train,
      hold: releaseTrainHold({
        train,
        code,
        reason,
        observedDevSha,
        observedCandidateSha: sourceLockSha,
        observedCandidateTreeSha: candidateTreeSha,
        observedAlphaBaseSha: alphaBaseSha,
        observedRuntimeSha: buildchainRuntimeSha,
        recordedAt: observedAt,
        priorHold,
      }),
    };
  }
  return {
    status: "active",
    train,
    hold: null,
    drift: {
      observedDevSha,
      originDevSha: cut.originDevSha,
      moved: observedDevSha !== cut.originDevSha,
      observationRoot:
        train.observations.find(
          (observation) => observation.observedDevSha === observedDevSha,
        )?.observationRoot || null,
    },
  };
}

function activeTrainDecision({
  options,
  candidate,
  reconciliation,
  observedSourceHeadSha,
  targetSha,
}) {
  const cut = reconciliation.train.releaseCut;
  const eligible = reconciliation.status === "active";
  const body = {
    schema: "kungfu-buildchain-channel-candidate-decision/v1",
    eligible,
    reason: eligible
      ? "active-release-train"
      : reconciliation.status === "superseded"
        ? "active-release-train-superseded"
        : "active-release-train-held",
    repository: options.repository,
    source: { branch: options.sourceBranch, sha: cut.candidateSha },
    target: { branch: options.targetBranch, sha: targetSha },
    comparison: { status: "frozen-release-cut", aheadBy: 0 },
    selection: {
      mode: "active-release-train",
      observedSourceHeadSha,
      skippedNewerCommitCount: 0,
      trainRoot: reconciliation.train.trainRoot,
      cutRoot: cut.cutRoot,
      generation: cut.generation,
      candidateTreeSha: cut.candidateTreeSha,
    },
    workflowEvidence: [],
    requiredWorkflowPaths: [],
    sourceLockRef: candidate.sourceLockRef,
    ...(reconciliation.hold
      ? {
          blockReason: reconciliation.hold.reason,
          holdRoot: reconciliation.hold.holdRoot,
        }
      : {}),
    decidedAt: options.now,
  };
  return { ...body, decisionRoot: evidenceRoot(body) };
}

function candidateIdentity(candidate) {
  return {
    sourceSha: candidate.sourceSha,
    sourceLockRef: candidate.sourceLockRef,
    decisionRoot: candidate.decisionRoot || null,
    pullRequestNumber: candidate.number,
    pullRequestUrl: candidate.url,
  };
}

function semanticState(value) {
  if (!value) return null;
  const normalized = { ...value };
  delete normalized.observedAt;
  delete normalized.observationDecisionRoot;
  delete normalized.stateRoot;
  delete normalized.priorStateRoot;
  return normalized;
}

export async function runActiveReleaseTrain({
  options,
  client,
  activeCandidate,
  adapters,
}) {
  const [observedSourceHeadSha, targetSha, sourceLockSha] = await Promise.all([
    client.resolveBranch(options.sourceBranch),
    client.resolveBranch(options.targetBranch),
    client.resolveBranch(activeCandidate.sourceLockRef),
  ]);
  if (!client.resolveCommitTreeSha) {
    throw new Error(
      "active Release Train validation requires candidate tree readback",
    );
  }
  const candidateTreeSha = await client.resolveCommitTreeSha(
    activeCandidate.sourceSha,
  );
  const reconciliation = reconcileActiveReleaseTrain({
    releaseTrain: activeCandidate.releaseTrain,
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    activeCandidateSha: activeCandidate.sourceSha,
    sourceLockSha,
    candidateTreeSha,
    alphaBaseSha: targetSha,
    buildchainRuntimeSha: options.buildchainRuntimeSha,
    observedDevSha: observedSourceHeadSha,
    observedAt: options.now,
    priorHold: activeCandidate.hold,
  });
  if (
    options.expectedCutRoot &&
    reconciliation.train.releaseCut.cutRoot !== options.expectedCutRoot
  ) {
    throw new Error(
      `active Release Cut changed between observation and settlement: expected ${options.expectedCutRoot}, observed ${reconciliation.train.releaseCut.cutRoot}`,
    );
  }
  const decision = activeTrainDecision({
    options,
    candidate: activeCandidate,
    reconciliation,
    observedSourceHeadSha,
    targetSha,
  });
  if (
    options.expectedSelectedSha &&
    decision.source.sha !== options.expectedSelectedSha
  ) {
    throw new Error(
      `selected source changed between observation and settlement: expected ${options.expectedSelectedSha}, observed ${decision.source.sha}`,
    );
  }
  const priorStateRoot = adapters.persistedStateRoot(activeCandidate);
  if (
    options.expectedPriorStateRoot &&
    options.expectedPriorStateRoot !== priorStateRoot
  ) {
    throw new Error(
      `candidate controller compare-and-swap failed: expected prior state root ${options.expectedPriorStateRoot}, observed ${priorStateRoot}`,
    );
  }
  const desiredState = adapters.candidateStateBody({
    options,
    targetSha,
    decision,
    activeCandidate: candidateIdentity(activeCandidate),
    nextCandidate: null,
    supersededCandidate: null,
    priorStateRoot,
    generation: reconciliation.train.releaseCut.generation,
    tombstones: activeCandidate.state?.tombstones || [],
    releaseTrain: reconciliation.train,
    hold: reconciliation.hold,
  });
  const transitionNeeded =
    !activeCandidate.state ||
    JSON.stringify(canonical(semanticState(activeCandidate.state))) !==
      JSON.stringify(canonical(semanticState(desiredState)));
  const state = transitionNeeded ? desiredState : activeCandidate.state;
  let settlementAction = "none";
  if (transitionNeeded && options.settlementAuthorized && !options.dryRun) {
    const nextBody = adapters.replaceCandidateStateMarker(
      activeCandidate.body,
      state,
    );
    await client.updatePullRequestBody(
      activeCandidate.number,
      nextBody,
      priorStateRoot,
    );
    settlementAction =
      reconciliation.status === "held"
        ? "hold-active-release-train"
        : reconciliation.status === "superseded"
          ? "record-superseded-release-train"
          : "observe-active-release-train";
  }
  const pullRequest = adapters.activePullRequest(activeCandidate);
  const autoMerge = await adapters.armCandidateAutoMerge(
    options,
    reconciliation.status,
    pullRequest,
    client,
  );
  return {
    schema: "kungfu-buildchain-dev-alpha-candidate-patrol/v1",
    dryRun: options.dryRun,
    createPullRequest: options.createPullRequest,
    settlementAuthorized: options.settlementAuthorized,
    autoMerge,
    decision,
    releaseTrain: reconciliation.train,
    drift: reconciliation.drift || null,
    hold: reconciliation.hold,
    controller: {
      schema: adapters.stateSchema,
      state: reconciliation.status,
      activeCandidate,
      nextCandidate: null,
      supersededCandidate: null,
      settlementAction,
      stateRoot: state.stateRoot,
      priorStateRoot,
      generation: reconciliation.train.releaseCut.generation,
      trainRoot: reconciliation.train.trainRoot,
      cutRoot: reconciliation.train.releaseCut.cutRoot,
      candidateTreeSha: reconciliation.train.releaseCut.candidateTreeSha,
      buildchainRuntimeSha:
        reconciliation.train.releaseCut.buildchainRuntimeSha,
      cutCreatedAt: reconciliation.train.releaseCut.createdAt,
      observedAt: options.now,
      holdRoot: reconciliation.hold?.holdRoot || null,
      tombstones: state.tombstones || [],
    },
    pullRequest,
  };
}
