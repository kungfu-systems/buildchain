import crypto from "node:crypto";
import {
  DEV_ALPHA_CANDIDATE_STATE_SCHEMA,
  STATE_MARKER_START,
  STATE_MARKER_END,
  EXACT_SHA,
  ABSENT_STATE_ROOT,
  text,
} from "./values.js";
export function canonical(value) {
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

export function evidenceRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export function candidateStateMarker(state) {
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

export function replaceCandidateStateMarker(bodyInput, state) {
  const body = String(bodyInput || "").trimEnd();
  const start = body.indexOf(STATE_MARKER_START);
  if (start < 0) return `${body}\n\n${candidateStateMarker(state)}\n`;
  const end = body.indexOf(STATE_MARKER_END, start);
  if (end < 0) throw new Error("malformed Buildchain candidate state marker");
  return `${body.slice(0, start).trimEnd()}\n\n${candidateStateMarker(state)}\n`;
}

export function targetSlug(targetBranch) {
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
  if (headRef.startsWith(expectedPrefix))
    throw new Error(
      `candidate PR #${pullRequest.number} is missing its current authoritative state marker`,
    );
  return undefined;
}

export function candidateStateBody({
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

export function persistedStateRoot(candidate) {
  return text(candidate?.state?.stateRoot) || ABSENT_STATE_ROOT;
}

export function candidateTombstone({
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
