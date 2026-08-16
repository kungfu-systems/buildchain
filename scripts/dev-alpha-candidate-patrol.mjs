#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { decideChannelCandidate } from "../packages/core/channel-candidate.js";
import {
  resolveManagedPromotionBaseline,
  resolvePatrolSourceInputs,
} from "../packages/core/channel-promotion-baseline.js";
import {
  cutInitialReleaseTrain,
  reconcileActiveReleaseTrain,
  resolveManagedCandidate,
  runActiveReleaseTrain,
} from "../packages/core/dev-alpha-active-release-train.js";
import {
  blockedCandidateDecision,
  candidateFromDecision,
  selectLatestQualifiedSource,
} from "../packages/core/dev-alpha-candidate-selection.js";
import { readGitHubNextDevelopmentVersionReservation } from "../packages/core/next-development-candidate-reservation.js";

export { reconcileActiveReleaseTrain, selectLatestQualifiedSource };

export const DEV_ALPHA_CANDIDATE_STATE_SCHEMA =
  "kungfu-buildchain-dev-alpha-candidate-state/v1";
const STATE_MARKER_START = "<!-- buildchain-dev-alpha-candidate-state";
const STATE_MARKER_END = "-->";
const LEGACY_BODY_MARKER = "Buildchain exact-source channel candidate.";
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const EVIDENCE_ROOT = /^sha256:[0-9a-f]{64}$/u;
const ABSENT_STATE_ROOT = "absent";

function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function autoMergeMethod(value, fallback = "merge") {
  const normalized = text(value || fallback).toLowerCase();
  if (!["merge", "squash", "rebase"].includes(normalized)) {
    throw new Error(
      `mergeMethod must be merge, squash, or rebase, got ${value || "<empty>"}`,
    );
  }
  return normalized;
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized))
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  return normalized;
}

function branch(value, name) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (
    !normalized ||
    normalized.startsWith("-") ||
    /[\s~^:?*[\\]/.test(normalized)
  ) {
    throw new Error(`${name} is not a valid branch name`);
  }
  return normalized;
}

function workflowPath(value, name) {
  const normalized = text(value);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(normalized)) {
    throw new Error(`${name} must be a repository workflow path`);
  }
  return normalized;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pullRequestBodyPrefix(value) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > 32768)
    throw new Error("pullRequestBodyPrefix exceeds 32768 characters");
  if (normalized.includes(STATE_MARKER_START))
    throw new Error(
      "pullRequestBodyPrefix must not contain the managed candidate state marker",
    );
  return normalized;
}

function optionalExactSha(value, name) {
  const normalized = text(value);
  if (normalized && !EXACT_SHA.test(normalized))
    throw new Error(`${name} must be an exact 40-character commit SHA`);
  return normalized;
}

function optionalStateRoot(value, name) {
  const normalized = text(value);
  if (
    normalized &&
    normalized !== ABSENT_STATE_ROOT &&
    !EVIDENCE_ROOT.test(normalized)
  ) {
    throw new Error(`${name} must be absent or an exact sha256 root`);
  }
  return normalized;
}

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

function candidateStateMarker(state) {
  return `${STATE_MARKER_START}\n${JSON.stringify(state)}\n${STATE_MARKER_END}`;
}

export function parseCandidateStateMarker(bodyInput) {
  const body = String(bodyInput || "");
  const start = body.indexOf(STATE_MARKER_START);
  if (start < 0) return undefined;
  const jsonStart = body.indexOf("\n", start);
  const end = body.indexOf(STATE_MARKER_END, jsonStart + 1);
  if (jsonStart < 0 || end < 0)
    throw new Error("malformed Buildchain candidate state marker");
  const state = JSON.parse(body.slice(jsonStart + 1, end).trim());
  if (state.schema !== DEV_ALPHA_CANDIDATE_STATE_SCHEMA)
    throw new Error(
      `unsupported candidate state schema ${state.schema || "<empty>"}`,
    );
  return state;
}

function replaceCandidateStateMarker(bodyInput, state) {
  const body = String(bodyInput || "").trimEnd();
  const start = body.indexOf(STATE_MARKER_START);
  if (start < 0) return `${body}\n\n${candidateStateMarker(state)}\n`;
  const end = body.indexOf(STATE_MARKER_END, start);
  if (end < 0) throw new Error("malformed Buildchain candidate state marker");
  return `${body.slice(0, start).trimEnd()}\n\n${candidateStateMarker(state)}\n`;
}

function sourceShaFromLegacyBody(bodyInput) {
  return String(bodyInput || "").match(/- Source SHA: `([0-9a-f]{40})`/u)?.[1];
}

function targetSlug(targetBranch) {
  return targetBranch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function managedCandidateFromPullRequest(pullRequest, targetBranch) {
  const body = String(pullRequest.body || "");
  const marker = parseCandidateStateMarker(body);
  const expectedPrefix = `buildchain/candidate/${targetSlug(targetBranch)}/`;
  const headRef = text(pullRequest.head?.ref);
  const baseRef = text(pullRequest.base?.ref || targetBranch);
  if (baseRef !== targetBranch) return undefined;
  if (marker) {
    if (marker.targetBranch !== targetBranch)
      throw new Error(
        `candidate PR #${pullRequest.number} state targets ${marker.targetBranch}, not ${targetBranch}`,
      );
    if (!headRef.startsWith(expectedPrefix))
      throw new Error(
        `candidate PR #${pullRequest.number} head ${headRef} is outside ${expectedPrefix}`,
      );
    const sourceSha = text(marker.activeCandidate?.sourceSha);
    if (
      !EXACT_SHA.test(sourceSha) ||
      headRef !== `${expectedPrefix}${sourceSha.slice(0, 12)}`
    ) {
      throw new Error(
        `candidate PR #${pullRequest.number} state does not bind its exact source-lock head`,
      );
    }
    return {
      number: Number(pullRequest.number),
      nodeId: text(pullRequest.node_id),
      autoMerge: pullRequest.auto_merge || null,
      url: text(pullRequest.html_url),
      body,
      sourceSha,
      sourceLockRef: headRef,
      decisionRoot: text(marker.activeCandidate?.decisionRoot),
      nextCandidate: marker.nextCandidate || null,
      releaseTrain: marker.releaseTrain || null,
      hold: marker.hold || null,
      state: marker,
    };
  }
  if (!body.includes(LEGACY_BODY_MARKER) || !headRef.startsWith(expectedPrefix))
    return undefined;
  const sourceSha = sourceShaFromLegacyBody(body);
  if (!sourceSha)
    throw new Error(
      `legacy candidate PR #${pullRequest.number} has no exact source SHA`,
    );
  if (headRef !== `${expectedPrefix}${sourceSha.slice(0, 12)}`)
    throw new Error(
      `legacy candidate PR #${pullRequest.number} does not bind its exact source-lock head`,
    );
  return {
    number: Number(pullRequest.number),
    nodeId: text(pullRequest.node_id),
    autoMerge: pullRequest.auto_merge || null,
    url: text(pullRequest.html_url),
    body,
    sourceSha,
    sourceLockRef: headRef,
    decisionRoot: "",
    nextCandidate: null,
    releaseTrain: null,
    hold: null,
    state: null,
  };
}

export function normalizeDevAlphaPatrolOptions(options = {}) {
  const createPullRequest = bool(
    options.createPullRequest ??
      process.env.BUILDCHAIN_CHANNEL_PATROL_CREATE_PR,
    false,
  );
  return {
    repository: repository(
      options.repository ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_REPOSITORY ??
        process.env.GITHUB_REPOSITORY,
    ),
    sourceBranch: branch(
      options.sourceBranch ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH ??
        "dev/v4/v4.0",
      "sourceBranch",
    ),
    targetBranch: branch(
      options.targetBranch ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH ??
        "alpha/v4/v4.0",
      "targetBranch",
    ),
    devWorkflowPath: workflowPath(
      options.devWorkflowPath ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_DEV_WORKFLOW ??
        ".github/workflows/dev-verify-patrol.yml",
      "devWorkflowPath",
    ),
    alphaWorkflowPath: workflowPath(
      options.alphaWorkflowPath ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_ALPHA_WORKFLOW ??
        ".github/workflows/alpha-promotion-preflight.yml",
      "alphaWorkflowPath",
    ),
    maxAgeSeconds: integer(
      options.maxAgeSeconds ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_MAX_AGE_SECONDS,
      7 * 24 * 60 * 60,
    ),
    pullRequestBodyPrefix: pullRequestBodyPrefix(
      options.pullRequestBodyPrefix ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX,
    ),
    expectedSelectedSha: optionalExactSha(
      options.expectedSelectedSha ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_SELECTED_SHA,
      "expectedSelectedSha",
    ),
    expectedPriorStateRoot: optionalStateRoot(
      options.expectedPriorStateRoot ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_PRIOR_STATE_ROOT,
      "expectedPriorStateRoot",
    ),
    expectedCutRoot: optionalStateRoot(
      options.expectedCutRoot ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_CUT_ROOT,
      "expectedCutRoot",
    ),
    cutCreatedAt: text(
      options.cutCreatedAt ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_CUT_CREATED_AT,
    ),
    requireActiveReleaseTrain: bool(
      options.requireActiveReleaseTrain ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_REQUIRE_ACTIVE_TRAIN,
      true,
    ),
    buildchainRuntimeSha: optionalExactSha(
      options.buildchainRuntimeSha ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_RUNTIME_SHA,
      "buildchainRuntimeSha",
    ),
    reactivationAuthorized: bool(
      options.reactivationAuthorized ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_REACTIVATION_AUTHORIZED,
      false,
    ),
    transitionAuthority: {
      actor: text(
        options.transitionAuthority?.actor ?? process.env.GITHUB_ACTOR,
      ),
      workflow: text(
        options.transitionAuthority?.workflow ?? process.env.GITHUB_WORKFLOW,
      ),
      runId: text(
        options.transitionAuthority?.runId ?? process.env.GITHUB_RUN_ID,
      ),
      runAttempt: text(
        options.transitionAuthority?.runAttempt ??
          process.env.GITHUB_RUN_ATTEMPT,
      ),
    },
    createPullRequest,
    settlementAuthorized: bool(
      options.settlementAuthorized ??
        process.env.BUILDCHAIN_CHANNEL_PATROL_SETTLEMENT_AUTHORIZED,
      createPullRequest,
    ),
    autoMerge: bool(
      options.autoMerge ?? process.env.BUILDCHAIN_CHANNEL_PATROL_AUTO_MERGE,
      false,
    ),
    mergeMethod: autoMergeMethod(
      options.mergeMethod ?? process.env.BUILDCHAIN_CHANNEL_PATROL_MERGE_METHOD,
    ),
    dryRun: bool(
      options.dryRun ?? process.env.BUILDCHAIN_CHANNEL_PATROL_DRY_RUN,
      true,
    ),
    now:
      text(options.now ?? process.env.BUILDCHAIN_CHANNEL_PATROL_NOW) ||
      new Date().toISOString(),
    outputPath:
      text(
        options.outputPath ?? process.env.BUILDCHAIN_CHANNEL_PATROL_OUTPUT_PATH,
      ) || ".buildchain/patrol/dev-alpha-candidate.json",
  };
}

function candidateStateBody({
  options,
  targetSha,
  decision,
  activeCandidate,
  nextCandidate,
  supersededCandidate,
  priorStateRoot = ABSENT_STATE_ROOT,
  generation = 1,
  tombstones = [],
  releaseTrain = null,
  hold = null,
}) {
  const body = {
    schema: DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    targetSha,
    generation,
    priorStateRoot,
    activeCandidate,
    nextCandidate,
    tombstones,
    ...(releaseTrain ? { releaseTrain } : {}),
    ...(hold ? { hold } : {}),
    observationDecisionRoot: decision.decisionRoot || null,
    observedAt: options.now,
    ...(supersededCandidate ? { supersededCandidate } : {}),
  };
  return { ...body, stateRoot: evidenceRoot(body) };
}

function persistedStateRoot(candidate) {
  return text(candidate?.state?.stateRoot) || ABSENT_STATE_ROOT;
}

function candidateTombstone({
  options,
  candidate,
  generation,
  priorStateRoot,
  reason,
  pullRequest,
}) {
  const body = {
    schema: "kungfu-buildchain-dev-alpha-candidate-tombstone/v1",
    repository: options.repository,
    targetBranch: options.targetBranch,
    candidateSha: candidate.sourceSha,
    qualificationRoot:
      candidate.qualificationRoot ||
      evidenceRoot({
        sourceSha: candidate.sourceSha,
        workflowEvidence: candidate.workflowEvidence || [],
      }),
    generation,
    priorStateRoot,
    reason,
    transitionAuthority: options.transitionAuthority,
    pullRequest: pullRequest
      ? {
          number: Number(pullRequest.number),
          url: text(pullRequest.url || pullRequest.html_url),
        }
      : null,
    workflowRuns: (candidate.workflowEvidence || []).map((row) => ({
      workflowPath: row.workflowPath,
      runId: row.runId,
      runAttempt: row.runAttempt,
      url: row.url,
    })),
    recordedAt: options.now,
  };
  return { ...body, tombstoneRoot: evidenceRoot(body) };
}

function pullRequestBody({
  options,
  observedSourceHeadSha,
  sourceSha,
  skippedNewerCommitCount,
  targetSha,
  decision,
  state,
}) {
  return [
    ...(options.pullRequestBodyPrefix
      ? [options.pullRequestBodyPrefix, ""]
      : []),
    LEGACY_BODY_MARKER,
    "",
    `- Source branch: \`${options.sourceBranch}\``,
    `- Observed source HEAD: \`${observedSourceHeadSha}\``,
    `- Source SHA: \`${sourceSha}\``,
    `- Skipped newer unqualified commits: \`${skippedNewerCommitCount}\``,
    `- Target branch/head: \`${options.targetBranch}\` / \`${targetSha}\``,
    `- Decision root: \`${decision.decisionRoot}\``,
    ...decision.workflowEvidence.map(
      (row) =>
        `- ${row.workflowName}: [run ${row.runId} attempt ${row.runAttempt}](${row.url})`,
    ),
    "",
    "The source-lock branch must continue to point at the exact source SHA. This patrol never directly merges the PR, publishes a package, creates a tag, or creates a release. Repository policy may arm GitHub auto-merge while every protected branch gate remains authoritative.",
    "",
    candidateStateMarker(state),
  ].join("\n");
}

async function armCandidateAutoMerge(
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

function activePullRequest(candidate) {
  return {
    number: candidate.number,
    node_id: candidate.nodeId,
    auto_merge: candidate.autoMerge,
    html_url: candidate.url,
  };
}

async function resumeActiveTrainIfPresent(options, client, candidate) {
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

function assertExpectedSelection(options, decision) {
  if (
    options.expectedSelectedSha &&
    decision.source.sha !== options.expectedSelectedSha
  ) {
    throw new Error(
      `selected source changed between observation and settlement: expected ${options.expectedSelectedSha}, observed ${decision.source.sha}`,
    );
  }
}

function assertExpectedStateRoot(options, priorStateRoot) {
  if (
    options.expectedPriorStateRoot &&
    options.expectedPriorStateRoot !== priorStateRoot
  ) {
    throw new Error(
      `candidate controller compare-and-swap failed: expected prior state root ${options.expectedPriorStateRoot}, observed ${priorStateRoot}`,
    );
  }
}

async function maybeCutReleaseTrain({
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

function initialControllerState(decision, qualificationError) {
  if (decision.eligible) return "eligible-for-settlement";
  if (!qualificationError) return "observed";
  return /stale/u.test(qualificationError.message) ? "stale" : "blocked";
}

export async function runDevAlphaCandidatePatrol(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeDevAlphaPatrolOptions(optionsInput);
  if (options.sourceBranch === options.targetBranch)
    throw new Error("source and target branches must differ");
  const client =
    clientInput ||
    createGitHubChannelCandidateClient({
      repository: options.repository,
      token: process.env.GITHUB_TOKEN,
    });
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

function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubChannelCandidateClient({
  repository: repositoryInput,
  token,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: token ? `Bearer ${token}` : undefined,
    "user-agent": "buildchain-dev-alpha-candidate-patrol",
    "x-github-api-version": "2022-11-28",
  };
  async function api(
    requestPath,
    { method = "GET", body, allow404 = false } = {},
  ) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value),
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const payload = raw ? JSON.parse(raw) : undefined;
      if (allow404 && response.status === 404) return undefined;
      if (response.ok) return payload;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 3) {
        const retryAfterHeader = response.headers?.get?.("retry-after");
        const retryAfter =
          retryAfterHeader === null || retryAfterHeader === undefined
            ? Number.NaN
            : Number(retryAfterHeader);
        await sleepImpl(
          Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.min(retryAfter * 1000, 10_000)
            : attempt * 250,
        );
        continue;
      }
      throw new Error(
        `GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`,
      );
    }
    throw new Error(`GitHub API ${method} ${requestPath} exhausted retries`);
  }
  return {
    async resolveBranch(ref) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
      );
      return text(payload.object?.sha);
    },
    async resolveCommitTreeSha(commitSha) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/commits/${encodeURIComponent(commitSha)}`,
      );
      if (text(payload.sha) !== commitSha) {
        throw new Error(
          `candidate commit readback returned ${payload.sha || "<empty>"}, not ${commitSha}`,
        );
      }
      return optionalExactSha(payload.tree?.sha, "candidateTreeSha");
    },
    async compare(baseSha, headSha) {
      return api(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);
    },
    resolveManagedPromotionBaseline: (targetSha, targetBranch) =>
      resolveManagedPromotionBaseline({
        api: (requestPath) => api(`/repos/${owner}/${repo}${requestPath}`),
        targetSha,
        targetBranch,
        parseCandidate: managedCandidateFromPullRequest,
      }),
    async readNextDevelopmentVersionReservation({
      reservationSha,
      candidateSha,
      targetVersion,
    }) {
      return readGitHubNextDevelopmentVersionReservation({
        api,
        owner,
        repo,
        reservationSha,
        candidateSha,
        targetVersion,
      });
    },
    async listCompletedWorkflowRuns(workflowPathValue, sourceBranch) {
      const runs = [];
      for (let page = 1; page <= 10; page += 1) {
        const payload = await api(
          `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowPathValue)}/runs?branch=${encodeURIComponent(sourceBranch)}&status=completed&per_page=100&page=${page}`,
        );
        const rows = payload.workflow_runs || [];
        runs.push(...rows);
        if (rows.length < 100) return runs;
      }
      throw new Error(
        `${workflowPathValue} completed workflow history exceeds 1000 runs`,
      );
    },
    async listBranchHistory(sourceBranch, targetSha) {
      const commits = [];
      for (let page = 1; page <= 10; page += 1) {
        const rows = await api(
          `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(sourceBranch)}&per_page=100&page=${page}`,
        );
        for (const commit of rows) {
          const commitSha = text(commit.sha);
          if (commitSha === targetSha) return commits;
          commits.push({
            sha: commitSha,
            message: text(commit.commit?.message),
            parents: (commit.parents || []).map((parent) => text(parent.sha)),
          });
        }
        if (rows.length < 100) return commits;
      }
      return commits;
    },
    async listOpenPullRequests(base) {
      const pullRequests = [];
      for (let page = 1; page <= 10; page += 1) {
        const rows = await api(
          `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
        );
        pullRequests.push(...rows);
        if (rows.length < 100) return pullRequests;
      }
      throw new Error(
        `open pull request history for ${base} exceeds 1000 rows`,
      );
    },
    async ensureImmutableBranch(ref, sourceSha) {
      const current = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
        { allow404: true },
      );
      if (current && current.object?.sha !== sourceSha) {
        throw new Error(
          `source-lock branch ${ref} points to ${current.object?.sha}, not ${sourceSha}`,
        );
      }
      if (current) return current;
      return api(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref}`, sha: sourceSha },
      });
    },
    async ensurePullRequest({ head, base, title, body }) {
      const known = await api(
        `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=20`,
      );
      if (known.length > 1) {
        throw new Error(
          `multiple known candidate pull requests bind ${head}: ${known
            .map((row) => `#${row.number}`)
            .join(", ")}`,
        );
      }
      if (known[0]) return { ...known[0], reused: true };
      return api(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { head, base, title, body },
      });
    },
    async enableAutoMerge(pullRequest, mergeMethod) {
      if (!text(pullRequest.node_id)) {
        throw new Error("candidate pull request has no GraphQL node id");
      }
      const query = `mutation($id:ID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$mergeMethod}){pullRequest{url}}}`;
      return api("/graphql", {
        method: "POST",
        body: {
          query,
          variables: {
            id: pullRequest.node_id,
            mergeMethod: autoMergeMethod(mergeMethod).toUpperCase(),
          },
        },
      });
    },
    async updatePullRequestBody(
      number,
      body,
      expectedPriorStateRoot = ABSENT_STATE_ROOT,
    ) {
      const current = await api(`/repos/${owner}/${repo}/pulls/${number}`);
      const observedPriorStateRoot = persistedStateRoot({
        state: parseCandidateStateMarker(current.body),
      });
      if (observedPriorStateRoot !== expectedPriorStateRoot) {
        throw new Error(
          `candidate controller compare-and-swap failed: expected prior state root ${expectedPriorStateRoot}, observed ${observedPriorStateRoot}`,
        );
      }
      return api(`/repos/${owner}/${repo}/pulls/${number}`, {
        method: "PATCH",
        body: { body },
      });
    },
  };
}

function markdown(result) {
  return [
    "## Buildchain Dev to Alpha candidate patrol",
    "",
    `Eligible: \`${result.decision.eligible}\` (${result.decision.reason})`,
    `Source: \`${result.decision.source.branch}@${result.decision.source.sha}\``,
    `Target: \`${result.decision.target.branch}@${result.decision.target.sha}\``,
    `Controller state: \`${result.controller.state}\``,
    `Release Train: \`${result.controller.trainRoot || "none"}\``,
    `Candidate generation: \`${result.controller.generation}\``,
    `Candidate tree: \`${result.controller.candidateTreeSha || "none"}\``,
    `Buildchain runtime: \`${result.controller.buildchainRuntimeSha || "none"}\``,
    `Drift observation: \`${result.drift?.observationRoot || "none"}\``,
    `Hold: \`${result.controller.holdRoot || "none"}\``,
    `Active candidate: ${result.controller.activeCandidate?.url || "none"}`,
    `Next candidate: \`${result.controller.nextCandidate?.sourceSha || "none"}\``,
    `Settlement action: \`${result.controller.settlementAction}\``,
    `Dry run: \`${result.dryRun}\``,
    `Pull request: ${result.pullRequest?.html_url || "not created"}`,
    "",
  ].join("\n");
}

async function main() {
  const options = normalizeDevAlphaPatrolOptions();
  const result = await runDevAlphaCandidatePatrol(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = markdown(result);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      "result-path": options.outputPath,
      eligible: String(result.decision.eligible),
      "selected-sha": result.decision.source.sha,
      "source-lock-ref": result.decision.sourceLockRef || "",
      "promotion-pr": result.pullRequest?.html_url || "",
      "controller-state": result.controller.state,
      "active-candidate-pr": result.controller.activeCandidate?.url || "",
      "next-candidate-sha": result.controller.nextCandidate?.sourceSha || "",
      "settlement-action": result.controller.settlementAction,
      "prior-state-root": result.controller.priorStateRoot,
      "train-root": result.controller.trainRoot || "",
      "cut-root": result.controller.cutRoot || "",
      "candidate-generation": String(result.controller.generation),
      "candidate-tree-sha": result.controller.candidateTreeSha || "",
      "runtime-sha": result.controller.buildchainRuntimeSha || "",
      "cut-created-at": result.controller.cutCreatedAt || "",
      "observed-at": result.controller.observedAt || "",
      "drift-root": result.drift?.observationRoot || "",
      "hold-root": result.controller.holdRoot || "",
    };
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
