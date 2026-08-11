// SPDX-License-Identifier: Apache-2.0

import {
  nextDevelopmentPatrolContext,
  normalizeNextDevelopmentVersionReservation,
} from "./next-development-candidate-reservation.js";

const SHA = /^[0-9a-f]{40}$/;

function text(value = "") {
  return String(value ?? "").trim();
}

function exactSha(value, name) {
  const normalized = text(value).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${name} must be an exact 40-character SHA`);
  return normalized;
}

export function normalizeManagedPromotionBaseline(input) {
  const pullRequestNumber = Number(input?.pullRequestNumber);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error(
      "targetBaseline.pullRequestNumber must be a positive integer",
    );
  }
  const pullRequestUrl = text(input?.pullRequestUrl);
  if (!pullRequestUrl)
    throw new Error("targetBaseline.pullRequestUrl is required");
  return {
    mode: text(input?.mode) || "managed-candidate-merge-source",
    targetSha: exactSha(input?.targetSha, "targetBaseline.targetSha"),
    sourceSha: exactSha(input?.sourceSha, "targetBaseline.sourceSha"),
    pullRequestNumber,
    pullRequestUrl,
  };
}

export function normalizeChannelCandidateSelection(input) {
  if (!input) return undefined;
  const mode = text(input.mode);
  if (!mode) throw new Error("selection.mode is required");
  const skippedNewerCommitCount = Number(input.skippedNewerCommitCount || 0);
  if (
    !Number.isSafeInteger(skippedNewerCommitCount) ||
    skippedNewerCommitCount < 0
  ) {
    throw new Error(
      "selection.skippedNewerCommitCount must be a non-negative integer",
    );
  }
  return {
    mode,
    observedSourceHeadSha: exactSha(
      input.observedSourceHeadSha,
      "selection.observedSourceHeadSha",
    ),
    skippedNewerCommitCount,
    ...(input.targetBaseline
      ? {
          targetBaseline: normalizeManagedPromotionBaseline(
            input.targetBaseline,
          ),
        }
      : {}),
    ...(input.versionReservation
      ? {
          versionReservation: normalizeNextDevelopmentVersionReservation(
            input.versionReservation,
            {
              reservationSha: input.versionReservation.reservationSha,
              candidateSha: input.versionReservation.candidateSha,
              targetVersion: input.versionReservation.targetVersion,
            },
          ),
        }
      : {}),
  };
}

export async function resolveChannelComparisonBaseline({
  client,
  targetSha,
  targetBranch,
  sourceSha,
  directComparison,
}) {
  if (
    directComparison.status !== "diverged" ||
    !client.resolveManagedPromotionBaseline
  ) {
    return { comparison: directComparison, targetBaseline: undefined };
  }
  const promoted = await client.resolveManagedPromotionBaseline(
    targetSha,
    targetBranch,
  );
  if (!promoted)
    return { comparison: directComparison, targetBaseline: undefined };
  const comparison = await client.compare(promoted.sourceSha, sourceSha);
  if (!["ahead", "identical"].includes(comparison.status)) {
    return { comparison: directComparison, targetBaseline: undefined };
  }
  return {
    comparison,
    targetBaseline: normalizeManagedPromotionBaseline(promoted),
  };
}

export async function resolvePatrolSourceInputs({
  client,
  options,
  requiredWorkflowPaths,
  selectQualifiedSource,
}) {
  const [observedSourceHeadSha, targetSha] = await Promise.all([
    client.resolveBranch(options.sourceBranch),
    client.resolveBranch(options.targetBranch),
  ]);
  const directComparison = await client.compare(
    targetSha,
    observedSourceHeadSha,
  );
  const { comparison: headComparison, targetBaseline } =
    await resolveChannelComparisonBaseline({
      client,
      targetSha,
      targetBranch: options.targetBranch,
      sourceSha: observedSourceHeadSha,
      directComparison,
    });
  let sourceSha = observedSourceHeadSha;
  let comparison = headComparison;
  let workflowEvidence = [];
  let skippedNewerCommitCount = 0;
  let versionReservation;
  let qualificationError;
  if (
    headComparison.status === "ahead" &&
    Number(headComparison.ahead_by) > 0
  ) {
    const boundarySha = targetBaseline?.sourceSha || targetSha;
    const [sourceHistory, ...workflowRunSets] = await Promise.all([
      client.listBranchHistory(options.sourceBranch, boundarySha),
      ...requiredWorkflowPaths.map((workflow) =>
        client.listCompletedWorkflowRuns(workflow, options.sourceBranch),
      ),
    ]);
    try {
      const { preparations, ignoredSourceShas } =
        nextDevelopmentPatrolContext(sourceHistory);
      const selected = selectQualifiedSource({
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
        ignoredSourceShas,
      });
      ({ sourceSha, skippedNewerCommitCount, workflowEvidence } = selected);
      const selectedIndex = sourceHistory.findIndex((entry) =>
        (typeof entry === "string" ? entry : entry?.sha) === sourceSha,
      );
      const reservation = preparations.find(
        ({ index }) => index > selectedIndex,
      )?.preparation;
      if (reservation) {
        if (typeof client.readNextDevelopmentVersionReservation !== "function") {
          throw new Error(
            "candidate follows next-development preparation but reservation readback is unavailable",
          );
        }
        versionReservation = normalizeNextDevelopmentVersionReservation(
          await client.readNextDevelopmentVersionReservation({
            reservationSha: reservation.sha,
            candidateSha: sourceSha,
            targetVersion: reservation.targetVersion,
          }),
          {
            reservationSha: reservation.sha,
            candidateSha: sourceSha,
            targetVersion: reservation.targetVersion,
          },
        );
        if (versionReservation.status !== "current") {
          throw new Error(
            `next-development version reservation is ${versionReservation.status} for candidate ${sourceSha}`,
          );
        }
      }
      if (sourceSha !== observedSourceHeadSha)
        comparison = await client.compare(boundarySha, sourceSha);
    } catch (error) {
      qualificationError = error;
    }
  }
  return {
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
  };
}

export async function resolveManagedPromotionBaseline({
  api,
  targetSha,
  targetBranch,
  parseCandidate,
}) {
  const commit = await api(`/git/commits/${targetSha}`);
  const parents = Array.isArray(commit.parents) ? commit.parents : [];
  if (text(commit.sha) !== targetSha || parents.length !== 2) return null;
  const sourceSha = text(parents[1]?.sha);
  if (!SHA.test(sourceSha)) return null;
  const associated = await api(`/commits/${targetSha}/pulls`);
  const managed = associated
    .filter(
      (pullRequest) =>
        text(pullRequest.merged_at) &&
        text(pullRequest.merge_commit_sha) === targetSha &&
        text(pullRequest.base?.ref) === targetBranch &&
        text(pullRequest.head?.sha) === sourceSha,
    )
    .map((pullRequest) => ({
      pullRequest,
      candidate: parseCandidate(pullRequest, targetBranch),
    }))
    .filter(({ candidate }) => candidate?.sourceSha === sourceSha);
  if (managed.length > 1)
    throw new Error(`multiple managed promotion PRs bind target ${targetSha}`);
  if (managed.length === 0) return null;
  return normalizeManagedPromotionBaseline({
    targetSha,
    sourceSha,
    pullRequestNumber: managed[0].pullRequest.number,
    pullRequestUrl: managed[0].pullRequest.html_url,
  });
}
