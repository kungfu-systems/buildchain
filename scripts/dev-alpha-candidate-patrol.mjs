#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { decideChannelCandidate } from "../packages/core/channel-candidate.js";

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
      url: text(pullRequest.html_url),
      body,
      sourceSha,
      sourceLockRef: headRef,
      decisionRoot: text(marker.activeCandidate?.decisionRoot),
      nextCandidate: marker.nextCandidate || null,
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
    url: text(pullRequest.html_url),
    body,
    sourceSha,
    sourceLockRef: headRef,
    decisionRoot: "",
    nextCandidate: null,
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

function latestWorkflowEvidence(runs, workflowPathValue, sourceSha) {
  const matching = runs
    .filter(
      (run) => run.path === workflowPathValue && run.head_sha === sourceSha,
    )
    .sort((left, right) => Number(right.id) - Number(left.id));
  if (matching.length === 0)
    throw new Error(
      `missing completed same-SHA workflow run: ${workflowPathValue}`,
    );
  const run = matching[0];
  return {
    workflowPath: workflowPathValue,
    workflowName: run.name,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
    url: run.html_url,
  };
}

function workflowEvidenceIsFreshAndSuccessful(run, { now, maxAgeSeconds }) {
  const completedAt = Date.parse(run.updated_at);
  const ageSeconds = (Date.parse(now) - completedAt) / 1000;
  return (
    run.status === "completed" &&
    run.conclusion === "success" &&
    Number.isFinite(ageSeconds) &&
    ageSeconds >= 0 &&
    ageSeconds <= maxAgeSeconds
  );
}

function latestRunsBySha(runs, workflowPathValue) {
  const latest = new Map();
  for (const run of runs.filter((row) => row.path === workflowPathValue)) {
    const current = latest.get(run.head_sha);
    if (!current || Number(run.id) > Number(current.id))
      latest.set(run.head_sha, run);
  }
  return latest;
}

export function selectLatestQualifiedSource({
  sourceHistory,
  workflowRunsByPath,
  requiredWorkflowPaths,
  now,
  maxAgeSeconds,
}) {
  const latestByPath = new Map(
    requiredWorkflowPaths.map((workflow) => [
      workflow,
      latestRunsBySha(workflowRunsByPath.get(workflow) || [], workflow),
    ]),
  );
  for (let index = 0; index < sourceHistory.length; index += 1) {
    const sourceSha = sourceHistory[index];
    const rows = requiredWorkflowPaths.map((workflow) =>
      latestByPath.get(workflow).get(sourceSha),
    );
    if (
      rows.every((run) =>
        workflowEvidenceIsFreshAndSuccessful(run || {}, { now, maxAgeSeconds }),
      )
    ) {
      return {
        sourceSha,
        skippedNewerCommitCount: index,
        workflowEvidence: requiredWorkflowPaths.map((workflow) =>
          latestWorkflowEvidence(
            workflowRunsByPath.get(workflow) || [],
            workflow,
            sourceSha,
          ),
        ),
      };
    }
  }
  const staleSuccessfulPair = sourceHistory.some((sourceSha) => {
    const rows = requiredWorkflowPaths.map((workflow) =>
      latestByPath.get(workflow).get(sourceSha),
    );
    return (
      rows.every(
        (run) =>
          run?.status === "completed" &&
          run?.conclusion === "success" &&
          run?.head_sha === sourceSha,
      ) &&
      rows.some(
        (run) =>
          !workflowEvidenceIsFreshAndSuccessful(run, { now, maxAgeSeconds }),
      )
    );
  });
  if (staleSuccessfulPair)
    throw new Error(
      "same-SHA workflow evidence is stale for every qualified source commit",
    );
  throw new Error(
    "no source commit ahead of target has fresh completed successful same-SHA workflow evidence",
  );
}

function blockedCandidateDecision({
  options,
  sourceSha,
  targetSha,
  comparison,
  reason,
}) {
  const body = {
    schema: "kungfu-buildchain-channel-candidate-decision/v1",
    eligible: false,
    reason: "qualification-evidence-blocked",
    repository: options.repository,
    source: { branch: options.sourceBranch, sha: sourceSha },
    target: { branch: options.targetBranch, sha: targetSha },
    comparison: {
      status: text(comparison.status || "unknown"),
      aheadBy: Number(comparison.ahead_by || 0),
    },
    blockReason: text(reason),
    decidedAt: options.now,
  };
  return { ...body, decisionRoot: evidenceRoot(body) };
}

function candidateFromDecision(decision) {
  if (!decision.eligible) return null;
  return {
    sourceSha: decision.source.sha,
    sourceLockRef: decision.sourceLockRef,
    decisionRoot: decision.decisionRoot,
    workflowEvidence: decision.workflowEvidence,
    qualificationRoot: evidenceRoot({
      sourceSha: decision.source.sha,
      workflowEvidence: decision.workflowEvidence,
    }),
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
    "The source-lock branch must continue to point at the exact source SHA. This patrol never merges the PR, publishes a package, creates a tag, or creates a release.",
    "",
    candidateStateMarker(state),
  ].join("\n");
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
  const [observedSourceHeadSha, targetSha] = await Promise.all([
    client.resolveBranch(options.sourceBranch),
    client.resolveBranch(options.targetBranch),
  ]);
  const headComparison = await client.compare(targetSha, observedSourceHeadSha);
  const requiredWorkflowPaths = [
    options.devWorkflowPath,
    options.alphaWorkflowPath,
  ];
  let sourceSha = observedSourceHeadSha;
  let comparison = headComparison;
  let workflowEvidence = [];
  let skippedNewerCommitCount = 0;
  let qualificationError;
  if (
    headComparison.status === "ahead" &&
    Number(headComparison.ahead_by) > 0
  ) {
    const [sourceHistory, ...workflowRunSets] = await Promise.all([
      client.listBranchHistory(options.sourceBranch, targetSha),
      ...requiredWorkflowPaths.map((workflow) =>
        client.listCompletedWorkflowRuns(workflow, options.sourceBranch),
      ),
    ]);
    try {
      const selected = selectLatestQualifiedSource({
        sourceHistory,
        workflowRunsByPath: new Map(
          requiredWorkflowPaths.map((workflow, index) => [
            workflow,
            workflowRunSets[index],
          ]),
        ),
        requiredWorkflowPaths,
        now: options.now,
        maxAgeSeconds: options.maxAgeSeconds,
      });
      sourceSha = selected.sourceSha;
      skippedNewerCommitCount = selected.skippedNewerCommitCount;
      workflowEvidence = selected.workflowEvidence;
      if (sourceSha !== observedSourceHeadSha)
        comparison = await client.compare(targetSha, sourceSha);
    } catch (error) {
      qualificationError = error;
    }
  }
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
          mode: "latest-qualified-source-ancestor",
          observedSourceHeadSha,
          skippedNewerCommitCount,
        },
        workflowEvidence,
        requiredWorkflowPaths,
        maxAgeSeconds: options.maxAgeSeconds,
        now: options.now,
      });
  if (
    options.expectedSelectedSha &&
    decision.source.sha !== options.expectedSelectedSha
  ) {
    throw new Error(
      `selected source changed between observation and settlement: expected ${options.expectedSelectedSha}, observed ${decision.source.sha}`,
    );
  }
  const openPullRequests = await client.listOpenPullRequests(
    options.targetBranch,
  );
  const managedCandidates = openPullRequests
    .map((pullRequest) =>
      managedCandidateFromPullRequest(pullRequest, options.targetBranch),
    )
    .filter(Boolean);
  for (const candidate of managedCandidates) {
    if (
      candidate.state &&
      (candidate.state.repository !== options.repository ||
        candidate.state.sourceBranch !== options.sourceBranch)
    ) {
      throw new Error(
        `candidate PR #${candidate.number} state does not bind ${options.repository} ${options.sourceBranch}`,
      );
    }
  }
  if (managedCandidates.length > 1) {
    throw new Error(
      `multiple open Buildchain candidate PRs target ${options.targetBranch}: ${managedCandidates
        .map((candidate) => `#${candidate.number}`)
        .join(", ")}`,
    );
  }
  let activeCandidate = managedCandidates[0] || null;
  const priorStateRoot = persistedStateRoot(activeCandidate);
  if (
    options.expectedPriorStateRoot &&
    options.expectedPriorStateRoot !== priorStateRoot
  ) {
    throw new Error(
      `candidate controller compare-and-swap failed: expected prior state root ${options.expectedPriorStateRoot}, observed ${priorStateRoot}`,
    );
  }
  const priorGeneration = Number(activeCandidate?.state?.generation || 0);
  let generation = Math.max(priorGeneration, 1);
  const priorTombstones = Array.isArray(activeCandidate?.state?.tombstones)
    ? activeCandidate.state.tombstones
    : [];
  const observedCandidate = candidateFromDecision(decision);
  let nextCandidate = null;
  let supersededCandidate = null;
  let tombstones = [...priorTombstones];
  let controllerState = decision.eligible
    ? "eligible-for-settlement"
    : qualificationError
      ? /stale/u.test(qualificationError.message)
        ? "stale"
        : "blocked"
      : "observed";
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
      pullRequest = {
        number: activeCandidate.number,
        html_url: activeCandidate.url,
      };
    } else if (decision.eligible) {
      await client.ensureImmutableBranch(decision.sourceLockRef, sourceSha);
      state = candidateStateBody({
        options,
        targetSha,
        decision,
        activeCandidate: observedCandidate,
        nextCandidate: null,
        supersededCandidate: null,
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
    schema: "kungfu-buildchain-dev-alpha-candidate-patrol/v1",
    dryRun: options.dryRun,
    createPullRequest: options.createPullRequest,
    settlementAuthorized: options.settlementAuthorized,
    decision,
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
    async compare(baseSha, headSha) {
      return api(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);
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
          commits.push(commitSha);
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
