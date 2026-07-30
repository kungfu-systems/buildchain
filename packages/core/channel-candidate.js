// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const CHANNEL_CANDIDATE_DECISION_SCHEMA =
  "kungfu-buildchain-channel-candidate-decision/v1";

const SHA = /^[0-9a-f]{40}$/;

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

function root(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function sha(value, name) {
  const normalized = required(value, name).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${name} must be an exact 40-character SHA`);
  return normalized;
}

function qualifyWorkflow(row, { sourceSha, now, maxAgeSeconds }) {
  if (!row || typeof row !== "object")
    throw new Error("workflow evidence is required");
  const workflowPath = required(row.workflowPath, "workflowPath");
  if (sha(row.headSha, `${workflowPath} headSha`) !== sourceSha) {
    throw new Error(
      `${workflowPath} evidence does not bind source SHA ${sourceSha}`,
    );
  }
  if (row.status !== "completed" || row.conclusion !== "success") {
    throw new Error(`${workflowPath} is not a completed successful run`);
  }
  const completedAt = required(row.completedAt, `${workflowPath} completedAt`);
  const ageSeconds = (Date.parse(now) - Date.parse(completedAt)) / 1000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > maxAgeSeconds
  ) {
    throw new Error(
      `${workflowPath} evidence is stale or has an invalid completion time`,
    );
  }
  const runId = Number(row.runId);
  const runAttempt = Number(row.runAttempt || 1);
  if (!Number.isSafeInteger(runId) || runId <= 0)
    throw new Error(`${workflowPath} runId is invalid`);
  if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    throw new Error(`${workflowPath} runAttempt is invalid`);
  return {
    workflowPath,
    workflowName: required(row.workflowName, `${workflowPath} workflowName`),
    runId,
    runAttempt,
    headSha: sourceSha,
    status: "completed",
    conclusion: "success",
    completedAt,
    url: required(row.url, `${workflowPath} url`),
  };
}

export function channelCandidateSourceLockRef(targetBranch, sourceSha) {
  const target = required(targetBranch, "targetBranch");
  const exactSha = sha(sourceSha, "sourceSha");
  return `buildchain/candidate/${target.replace(/[^A-Za-z0-9._-]+/g, "-")}/${exactSha.slice(0, 12)}`;
}

export function decideChannelCandidate(input) {
  const repository = required(input.repository, "repository");
  const sourceBranch = required(input.sourceBranch, "sourceBranch");
  const targetBranch = required(input.targetBranch, "targetBranch");
  if (sourceBranch === targetBranch)
    throw new Error("sourceBranch and targetBranch must differ");
  const sourceSha = sha(input.sourceSha, "sourceSha");
  const targetSha = sha(input.targetSha, "targetSha");
  const selection = input.selection
    ? {
        mode: required(input.selection.mode, "selection.mode"),
        observedSourceHeadSha: sha(
          input.selection.observedSourceHeadSha,
          "selection.observedSourceHeadSha",
        ),
        skippedNewerCommitCount: Number(
          input.selection.skippedNewerCommitCount || 0,
        ),
      }
    : undefined;
  if (
    selection &&
    (!Number.isSafeInteger(selection.skippedNewerCommitCount) ||
      selection.skippedNewerCommitCount < 0)
  ) {
    throw new Error(
      "selection.skippedNewerCommitCount must be a non-negative integer",
    );
  }
  const now = required(input.now || new Date().toISOString(), "now");
  const maxAgeSeconds = Number(input.maxAgeSeconds ?? 7 * 24 * 60 * 60);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error("maxAgeSeconds must be a positive integer");
  }
  const comparison = input.comparison || {};
  if (comparison.status !== "ahead" || Number(comparison.aheadBy) <= 0) {
    const reason =
      comparison.status === "identical"
        ? "target-already-current"
        : "source-does-not-lead-target";
    return {
      schema: CHANNEL_CANDIDATE_DECISION_SCHEMA,
      eligible: false,
      reason,
      repository,
      source: { branch: sourceBranch, sha: sourceSha },
      target: { branch: targetBranch, sha: targetSha },
      comparison: {
        status: String(comparison.status || "unknown"),
        aheadBy: Number(comparison.aheadBy || 0),
      },
      decidedAt: now,
    };
  }
  const rows = Array.isArray(input.workflowEvidence)
    ? input.workflowEvidence
    : [];
  const expectedPaths = [
    ...new Set((input.requiredWorkflowPaths || []).map(String)),
  ];
  if (expectedPaths.length === 0)
    throw new Error("requiredWorkflowPaths must not be empty");
  if (rows.length !== expectedPaths.length) {
    throw new Error(
      `expected exactly ${expectedPaths.length} workflow evidence rows, got ${rows.length}`,
    );
  }
  const byPath = new Map();
  for (const row of rows) {
    const qualified = qualifyWorkflow(row, { sourceSha, now, maxAgeSeconds });
    if (byPath.has(qualified.workflowPath)) {
      throw new Error(`duplicate workflow evidence: ${qualified.workflowPath}`);
    }
    byPath.set(qualified.workflowPath, qualified);
  }
  for (const workflowPath of expectedPaths) {
    if (!byPath.has(workflowPath))
      throw new Error(`missing workflow evidence: ${workflowPath}`);
  }
  const body = {
    schema: CHANNEL_CANDIDATE_DECISION_SCHEMA,
    eligible: true,
    reason: "same-source-qualified",
    repository,
    source: { branch: sourceBranch, sha: sourceSha },
    target: { branch: targetBranch, sha: targetSha },
    comparison: { status: "ahead", aheadBy: Number(comparison.aheadBy) },
    ...(selection ? { selection } : {}),
    sourceLockRef: channelCandidateSourceLockRef(targetBranch, sourceSha),
    workflowEvidence: expectedPaths.map((workflowPath) =>
      byPath.get(workflowPath),
    ),
    policy: { maxAgeSeconds, requiredWorkflowPaths: expectedPaths },
    decidedAt: now,
  };
  return { ...body, decisionRoot: root(body) };
}
