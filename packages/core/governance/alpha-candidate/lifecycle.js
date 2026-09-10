import { DEV_ALPHA_CANDIDATE_STATE_SCHEMA } from "./values.js";
import {
  runActiveReleaseTrain,
  cutInitialReleaseTrain,
} from "../../release/dev-alpha-active-release-train.js";
import {
  persistedStateRoot,
  candidateStateBody,
  replaceCandidateStateMarker,
} from "./state.js";
export async function armCandidateAutoMerge(
  options,
  controllerState,
  pullRequest,
  client,
) {
  if (
    !options.autoMerge ||
    !options.settlementAuthorized ||
    options.dryRun ||
    controllerState !== "active" ||
    !pullRequest
  ) {
    return {
      requested: options.autoMerge,
      enabled: false,
      mergeMethod: options.mergeMethod,
    };
  }
  if (!pullRequest.auto_merge) {
    await client.enableAutoMerge(pullRequest, options.mergeMethod);
  }
  return {
    requested: true,
    enabled: true,
    mergeMethod: options.mergeMethod,
  };
}

export function activePullRequest(candidate) {
  return {
    number: candidate.number,
    node_id: candidate.nodeId,
    auto_merge: candidate.autoMerge,
    html_url: candidate.url,
  };
}

export async function resumeActiveTrainIfPresent(options, client, candidate) {
  if (!options.requireActiveReleaseTrain || !candidate) return null;
  if (!candidate.releaseTrain) {
    throw new Error(
      `candidate PR #${candidate.number} has no authoritative active Release Train`,
    );
  }
  return runActiveReleaseTrain({
    options,
    client,
    activeCandidate: candidate,
    adapters: {
      stateSchema: DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
      persistedStateRoot,
      candidateStateBody,
      replaceCandidateStateMarker,
      activePullRequest,
      armCandidateAutoMerge,
    },
  });
}

export function assertExpectedSelection(options, decision) {
  if (
    options.expectedSelectedSha &&
    decision.source.sha !== options.expectedSelectedSha
  ) {
    throw new Error(
      `selected source changed between observation and settlement: expected ${options.expectedSelectedSha}, observed ${decision.source.sha}`,
    );
  }
}

export function assertExpectedStateRoot(options, priorStateRoot) {
  if (
    options.expectedPriorStateRoot &&
    options.expectedPriorStateRoot !== priorStateRoot
  ) {
    throw new Error(
      `candidate controller compare-and-swap failed: expected prior state root ${options.expectedPriorStateRoot}, observed ${priorStateRoot}`,
    );
  }
}

export async function maybeCutReleaseTrain({
  options,
  client,
  activeCandidate,
  decision,
  observedCandidate,
  sourceSha,
  targetSha,
  observedSourceHeadSha,
}) {
  if (!options.requireActiveReleaseTrain || activeCandidate) {
    return activeCandidate?.releaseTrain || null;
  }
  return cutInitialReleaseTrain({
    options,
    client,
    decision,
    candidate: observedCandidate,
    sourceSha,
    targetSha,
    observedSourceHeadSha,
  });
}

export function initialControllerState(decision, qualificationError) {
  if (decision.eligible) return "eligible-for-settlement";
  if (!qualificationError) return "observed";
  return /stale/u.test(qualificationError.message) ? "stale" : "blocked";
}
