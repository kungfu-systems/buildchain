import { DEV_ALPHA_CANDIDATE_STATE_SCHEMA, text } from "./values.js";
import { normalizeDevAlphaPatrolOptions } from "./options.js";
import { resolveManagedCandidate } from "../../release/dev-alpha-active-release-train.js";
import { resolvePatrolSourceInputs } from "../../release/channel-promotion-baseline.js";
import {
  blockedCandidateDecision,
  candidateFromDecision,
  selectLatestQualifiedSource,
} from "../../release/dev-alpha-candidate-selection.js";
import { decideChannelCandidate } from "../../release/channel-candidate.js";
import {
  managedCandidateFromPullRequest,
  persistedStateRoot,
  candidateTombstone,
  candidateStateBody,
  replaceCandidateStateMarker,
  parseCandidateStateMarker,
} from "./state.js";
import {
  resumeActiveTrainIfPresent,
  assertExpectedSelection,
  assertExpectedStateRoot,
  maybeCutReleaseTrain,
  initialControllerState,
  activePullRequest,
  armCandidateAutoMerge,
} from "./lifecycle.js";
import { pullRequestBody } from "./report.js";
function planCandidateTransition({
  options,
  activeCandidate,
  priorStateRoot,
  priorGeneration,
  generation,
  priorTombstones,
  observedCandidate,
  decision,
  qualificationError,
  targetSha,
  releaseTrain,
}) {
  let nextCandidate = null;
  let supersededCandidate = null;
  let tombstones = [...priorTombstones];
  let controllerState = initialControllerState(decision, qualificationError);
  if (activeCandidate) {
    controllerState = "active";
    nextCandidate = activeCandidate.nextCandidate || null;
    if (
      observedCandidate &&
      observedCandidate.sourceSha !== activeCandidate.sourceSha
    ) {
      const matchingTombstone = priorTombstones.find(
        (row) => row.candidateSha === observedCandidate.sourceSha,
      );
      if (matchingTombstone && !options.reactivationAuthorized) {
        controllerState = "tombstone-blocked";
      } else {
        if (
          nextCandidate &&
          nextCandidate.sourceSha !== observedCandidate.sourceSha
        ) {
          supersededCandidate = nextCandidate;
          generation = priorGeneration + 1;
          tombstones.push(
            candidateTombstone({
              options,
              candidate: supersededCandidate,
              generation,
              priorStateRoot,
              reason: "newer-qualified-next-candidate",
              pullRequest: activeCandidate,
            }),
          );
        }
        nextCandidate = observedCandidate;
        controllerState = "retained-next";
      }
    } else if (
      !decision.eligible &&
      nextCandidate &&
      decision.source.sha === nextCandidate.sourceSha
    ) {
      supersededCandidate = nextCandidate;
      nextCandidate = null;
      generation = priorGeneration + 1;
      tombstones.push(
        candidateTombstone({
          options,
          candidate: supersededCandidate,
          generation,
          priorStateRoot,
          reason: "qualification-evidence-rejected",
          pullRequest: activeCandidate,
        }),
      );
      controllerState = "rejected-next";
    }
  }
  const persistedNextSha = text(activeCandidate?.nextCandidate?.sourceSha);
  const desiredNextSha = text(nextCandidate?.sourceSha);
  const transitionNeeded =
    !activeCandidate?.state ||
    persistedNextSha !== desiredNextSha ||
    tombstones.length !== priorTombstones.length;
  if (transitionNeeded && activeCandidate && generation === priorGeneration) {
    generation = priorGeneration + 1;
  }
  let state =
    activeCandidate?.state && !transitionNeeded
      ? activeCandidate.state
      : candidateStateBody({
          options,
          targetSha,
          decision,
          activeCandidate: activeCandidate
            ? {
                sourceSha: activeCandidate.sourceSha,
                sourceLockRef: activeCandidate.sourceLockRef,
                decisionRoot: activeCandidate.decisionRoot || null,
                pullRequestNumber: activeCandidate.number,
                pullRequestUrl: activeCandidate.url,
              }
            : null,
          nextCandidate,
          supersededCandidate,
          priorStateRoot,
          generation,
          tombstones,
          releaseTrain,
        });

  return {
    nextCandidate,
    supersededCandidate,
    tombstones,
    controllerState,
    state,
    generation,
  };
}

async function settleCandidateTransition({
  options,
  client,
  activeCandidate,
  state,
  priorStateRoot,
  nextCandidate,
  supersededCandidate,
  decision,
  sourceSha,
  targetSha,
  observedCandidate,
  generation,
  releaseTrain,
  observedSourceHeadSha,
  skippedNewerCommitCount,
  priorTombstones,
  tombstones,
  controllerState,
}) {
  let pullRequest;
  let settlementAction = "none";
  if (options.settlementAuthorized && !options.dryRun) {
    if (activeCandidate) {
      const nextBody = replaceCandidateStateMarker(activeCandidate.body, state);
      if (nextBody !== activeCandidate.body) {
        await client.updatePullRequestBody(
          activeCandidate.number,
          nextBody,
          priorStateRoot,
        );
        settlementAction = nextCandidate
          ? supersededCandidate
            ? "supersede-next-candidate"
            : "retain-next-candidate"
          : "reconcile-active-candidate";
      }
      pullRequest = activePullRequest(activeCandidate);
    } else if (decision.eligible) {
      await client.ensureImmutableBranch(decision.sourceLockRef, sourceSha);
      state = candidateStateBody({
        options,
        targetSha,
        decision,
        activeCandidate: observedCandidate,
        nextCandidate: null,
        supersededCandidate: null,
        generation,
        releaseTrain,
      });
      pullRequest = await client.ensurePullRequest({
        head: decision.sourceLockRef,
        base: options.targetBranch,
        title: `Promote qualified ${options.sourceBranch} candidate ${sourceSha.slice(0, 12)} to ${options.targetBranch}`,
        body: pullRequestBody({
          options,
          observedSourceHeadSha,
          sourceSha,
          skippedNewerCommitCount,
          targetSha,
          decision,
          state,
        }),
      });
      if (pullRequest.state && pullRequest.state !== "open") {
        const tombstone = candidateTombstone({
          options,
          candidate: observedCandidate,
          generation,
          priorStateRoot,
          reason: pullRequest.merged_at
            ? "candidate-pr-merged"
            : "candidate-pr-closed",
          pullRequest,
        });
        tombstones = [...priorTombstones, tombstone];
        state = candidateStateBody({
          options,
          targetSha,
          decision,
          activeCandidate: null,
          nextCandidate: null,
          supersededCandidate: null,
          priorStateRoot,
          generation,
          tombstones,
          releaseTrain,
        });
        const nextBody = replaceCandidateStateMarker(pullRequest.body, state);
        await client.updatePullRequestBody(
          pullRequest.number,
          nextBody,
          persistedStateRoot({
            state: parseCandidateStateMarker(pullRequest.body),
          }),
        );
        settlementAction = "reuse-known-candidate-tombstone";
        controllerState = "tombstoned";
        activeCandidate = null;
      } else {
        settlementAction = pullRequest.reused
          ? "reuse-active-candidate"
          : "create-active-candidate";
        controllerState = "active";
        activeCandidate = {
          number: Number(pullRequest.number || 0),
          url: text(pullRequest.html_url),
          sourceSha,
          sourceLockRef: decision.sourceLockRef,
          decisionRoot: decision.decisionRoot,
        };
      }
    }
  }

  return {
    pullRequest,
    settlementAction,
    state,
    activeCandidate,
    tombstones,
    controllerState,
  };
}

function decideObservedCandidate({
  options,
  requiredWorkflowPaths,
  qualificationError,
  observedSourceHeadSha,
  targetSha,
  headComparison,
  sourceSha,
  comparison,
  targetBaseline,
  skippedNewerCommitCount,
  versionReservation,
  workflowEvidence,
}) {
  const decision = qualificationError
    ? blockedCandidateDecision({
        options,
        sourceSha: observedSourceHeadSha,
        targetSha,
        comparison: headComparison,
        reason: qualificationError.message,
      })
    : decideChannelCandidate({
        repository: options.repository,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        sourceSha,
        targetSha,
        comparison: { status: comparison.status, aheadBy: comparison.ahead_by },
        selection: {
          mode: targetBaseline
            ? "latest-qualified-source-after-managed-promotion"
            : "latest-qualified-source-ancestor",
          observedSourceHeadSha,
          skippedNewerCommitCount,
          ...(targetBaseline ? { targetBaseline } : {}),
          ...(versionReservation ? { versionReservation } : {}),
        },
        workflowEvidence,
        requiredWorkflowPaths,
        maxAgeSeconds: options.maxAgeSeconds,
        now: options.now,
      });

  return decision;
}

export async function runDevAlphaCandidatePatrol(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeDevAlphaPatrolOptions(optionsInput);
  if (options.sourceBranch === options.targetBranch)
    throw new Error("source and target branches must differ");
  const client = clientInput;
  if (!client)
    throw new Error(
      "Alpha candidate reconciliation requires an explicit provider client",
    );
  const requiredWorkflowPaths = [
    options.devWorkflowPath,
    options.alphaWorkflowPath,
  ];
  const persistedCandidate = await resolveManagedCandidate({
    client,
    targetBranch: options.targetBranch,
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    parseCandidate: managedCandidateFromPullRequest,
  });
  const resumed = await resumeActiveTrainIfPresent(
    options,
    client,
    persistedCandidate,
  );
  if (resumed) return resumed;
  const {
    observedSourceHeadSha,
    targetSha,
    headComparison,
    targetBaseline,
    sourceSha,
    comparison,
    workflowEvidence,
    skippedNewerCommitCount,
    versionReservation,
    qualificationError,
  } = await resolvePatrolSourceInputs({
    client,
    options,
    requiredWorkflowPaths,
    selectQualifiedSource: selectLatestQualifiedSource,
  });
  const decision = decideObservedCandidate({
    options,
    requiredWorkflowPaths,
    qualificationError,
    observedSourceHeadSha,
    targetSha,
    headComparison,
    sourceSha,
    comparison,
    targetBaseline,
    skippedNewerCommitCount,
    versionReservation,
    workflowEvidence,
  });
  assertExpectedSelection(options, decision);
  let activeCandidate = persistedCandidate;
  const priorStateRoot = persistedStateRoot(activeCandidate);
  assertExpectedStateRoot(options, priorStateRoot);
  const priorGeneration = Number(activeCandidate?.state?.generation || 0);
  let generation = Math.max(priorGeneration, 1);
  const priorTombstones = Array.isArray(activeCandidate?.state?.tombstones)
    ? activeCandidate.state.tombstones
    : [];
  const observedCandidate = candidateFromDecision(decision);
  const releaseTrain = await maybeCutReleaseTrain({
    options,
    client,
    activeCandidate,
    decision,
    observedCandidate,
    sourceSha,
    targetSha,
    observedSourceHeadSha,
  });
  generation = releaseTrain?.releaseCut.generation || generation;
  let {
    nextCandidate,
    supersededCandidate,
    tombstones,
    controllerState,
    state,
    generation: nextGeneration,
  } = planCandidateTransition({
    options,
    activeCandidate,
    priorStateRoot,
    priorGeneration,
    generation,
    priorTombstones,
    observedCandidate,
    decision,
    qualificationError,
    targetSha,
    releaseTrain,
  });
  generation = nextGeneration;
  const settled = await settleCandidateTransition({
    options,
    client,
    activeCandidate,
    state,
    priorStateRoot,
    nextCandidate,
    supersededCandidate,
    decision,
    sourceSha,
    targetSha,
    observedCandidate,
    generation,
    releaseTrain,
    observedSourceHeadSha,
    skippedNewerCommitCount,
    priorTombstones,
    tombstones,
    controllerState,
  });
  const { pullRequest, settlementAction } = settled;
  ({ state, activeCandidate, tombstones, controllerState } = settled);
  const autoMerge = await armCandidateAutoMerge(
    options,
    controllerState,
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
    releaseTrain,
    drift: releaseTrain
      ? {
          observedDevSha: observedSourceHeadSha,
          originDevSha: releaseTrain.releaseCut.originDevSha,
          moved: observedSourceHeadSha !== releaseTrain.releaseCut.originDevSha,
          observationRoot:
            releaseTrain.observations.find(
              (observation) =>
                observation.observedDevSha === observedSourceHeadSha,
            )?.observationRoot || null,
        }
      : null,
    hold: null,
    controller: {
      schema: DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
      state: controllerState,
      activeCandidate,
      nextCandidate,
      supersededCandidate,
      settlementAction,
      stateRoot: state.stateRoot,
      priorStateRoot,
      generation: state.generation,
      trainRoot: releaseTrain?.trainRoot || null,
      cutRoot: releaseTrain?.releaseCut.cutRoot || null,
      candidateTreeSha: releaseTrain?.releaseCut.candidateTreeSha || null,
      buildchainRuntimeSha:
        releaseTrain?.releaseCut.buildchainRuntimeSha ||
        options.buildchainRuntimeSha ||
        null,
      cutCreatedAt: releaseTrain?.releaseCut.createdAt || null,
      observedAt: options.now,
      holdRoot: null,
      tombstones: state.tombstones || [],
    },
    pullRequest: pullRequest || null,
  };
}
