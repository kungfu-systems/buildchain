// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

function text(value = "") {
  return String(value ?? "").trim();
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

function latestWorkflowEvidence(runs, workflowPath, sourceSha) {
  const matching = runs
    .filter(
      (run) =>
        run.conclusion !== "cancelled" &&
        run.path === workflowPath &&
        run.head_sha === sourceSha,
    )
    .sort((left, right) => Number(right.id) - Number(left.id));
  if (matching.length === 0) {
    throw new Error(`missing completed same-SHA workflow run: ${workflowPath}`);
  }
  const run = matching[0];
  return {
    workflowPath,
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

function latestRunsBySha(runs, workflowPath) {
  const latest = new Map();
  for (const run of runs.filter(
    (row) => row.path === workflowPath && row.conclusion !== "cancelled",
  )) {
    const current = latest.get(run.head_sha);
    if (!current || Number(run.id) > Number(current.id)) {
      latest.set(run.head_sha, run);
    }
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
        workflowEvidenceIsFreshAndSuccessful(run || {}, {
          now,
          maxAgeSeconds,
        }),
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
  if (staleSuccessfulPair) {
    throw new Error(
      "same-SHA workflow evidence is stale for every qualified source commit",
    );
  }
  throw new Error(
    "no source commit ahead of target has fresh completed successful same-SHA workflow evidence",
  );
}

export function blockedCandidateDecision({
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

export function candidateFromDecision(decision) {
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
