import {
  ADMISSION_CONTRACT,
  STATIC_SKIP_REASONS,
  contentRoot,
  normalizeOptions,
} from "./policy.js";
import {
  evaluatePullRequest,
  mergeableAccepted,
  rejectBaseMoveBeforeAtomicReplay,
  skip,
} from "./readiness.js";
import { GitHubClient, delay } from "./github-client.js";
import {
  qualifyAtomicQueueAdmission,
  setActiveLeaseStatus,
  setQueueAdmissionStatus,
} from "../commands/dev-pr-delivery-warrant.mjs";
export function queuePredecessor(queueState, fallback = {}) {
  const entry = queueState?.entries?.[0];
  if (entry) {
    return {
      queueEntryId: entry.id,
      pullRequestNumber: entry.pullRequestNumber,
      headSha: entry.pullRequestHeadSha || entry.headSha || "",
      state: entry.state || "",
    };
  }
  return {
    queueEntryId: fallback.queueEntryId || "",
    pullRequestNumber: fallback.pullRequestNumber || null,
    headSha: fallback.headSha || "",
    state: fallback.state || "",
  };
}

export function admissionReceipt({
  options,
  pr,
  expectedBaseSha,
  observedBaseSha,
  expectedHeadSha,
  observedHeadSha,
  decision,
  reason,
  checks,
  approval,
  predecessor,
  projectCut,
} = {}) {
  return {
    schemaVersion: 1,
    contract: ADMISSION_CONTRACT,
    repository: options.repository.fullName,
    targetBranch: options.targetBranch,
    pullRequestNumber: pr.number,
    expectedBaseSha: expectedBaseSha || "",
    observedBaseSha: observedBaseSha || "",
    expectedHeadSha: expectedHeadSha || "",
    observedHeadSha: observedHeadSha || "",
    approvalRequired: options.requireApproval,
    approval: approval || { required: options.requireApproval, passed: false },
    checks: checks || {
      required: options.requiredChecks,
      entries: [],
      passed: false,
    },
    decision,
    reason,
    predecessor: predecessor || null,
    projectCut: projectCut || null,
    finalSafetyBoundary: "github-merge-group",
  };
}

export function evaluatedEntry(pr, decision) {
  return {
    number: pr.number,
    title: pr.title || "",
    headRef: pr.head?.ref || "",
    headSha: pr.head?.sha || "",
    action: decision.action,
    reason: decision.reason,
    checks: decision.checks,
  };
}

export function blockRemainingPullRequests(
  result,
  pullRequests,
  startIndex,
  options,
  expectedBaseSha,
  predecessor,
) {
  for (const pr of pullRequests.slice(startIndex)) {
    const entry = evaluatedEntry(pr, {
      action: "skip",
      reason: "blocked-by-predecessor",
    });
    entry.admissionReceipt = admissionReceipt({
      options,
      pr,
      expectedBaseSha,
      observedBaseSha: expectedBaseSha,
      expectedHeadSha: pr.head?.sha || "",
      observedHeadSha: pr.head?.sha || "",
      decision: "blocked",
      reason: "blocked-by-predecessor",
      predecessor,
    });
    result.evaluated.push(entry);
    result.skipped.push(entry);
  }
}

export function finalizePatrolResult(result) {
  result.runKind = "cadence-patrol";
  result.outcome =
    result.evaluated.length === 0
      ? "no-op-no-candidates"
      : result.actions.length === 0
        ? "no-op-all-skipped"
        : "actions-present";
  result.qualification = false;
  result.noOp = result.actions.length === 0;
  return result;
}

export async function reconcileEnqueueError({
  client,
  options,
  pr,
  expectedHeadSha,
  entry,
  result,
  error,
}) {
  const queueReadback = await client
    .getMergeQueueState(options.targetBranch)
    .catch(() => null);
  const exactEntry = queueReadback?.entries?.find(
    (candidate) =>
      candidate.pullRequestNumber === pr.number &&
      candidate.pullRequestHeadSha === expectedHeadSha,
  );
  if (exactEntry) {
    entry.activeLeaseStatus = await setActiveLeaseStatus(
      client,
      options.repository,
      expectedHeadSha,
      options.activeLeaseContext,
      "pending",
    );
    entry.action = "enqueued";
    entry.reason = "already-enqueued-exact-head";
    entry.queueEntry = exactEntry;
    entry.admissionReceipt.reason = entry.reason;
    result.actions.push(entry);
    result.enqueued.push(entry);
    return;
  }
  entry.queueAdmissionStatus = await setQueueAdmissionStatus(
    client,
    options.repository,
    expectedHeadSha,
    options.queueAdmissionContext,
    "failure",
  );
  entry.activeLeaseStatus = await setActiveLeaseStatus(
    client,
    options.repository,
    expectedHeadSha,
    options.activeLeaseContext,
    "failure",
  );
  entry.action = "skip";
  entry.reason = error.preEnqueue
    ? error.code || "pre-enqueue-qualification-failed"
    : "enqueue-rejected";
  entry.enqueueError = {
    phase: error.preEnqueue ? "pre-enqueue" : "enqueue",
    status: error.status || null,
    message: error.message || "GitHub rejected merge queue admission",
  };
  entry.admissionReceipt.decision = "rejected";
  entry.admissionReceipt.reason = entry.reason;
  result.skipped.push(entry);
}

function decideQueueAdmission({
  options,
  observedQueueState,
  initialBaseSha,
  observedBaseSha,
  observedHeadSha,
  expectedHeadSha,
  observedPullRequest,
  landingMode,
  decision,
}) {
  let admissionDecision = options.dryRun ? "planned" : "accepted";
  let admissionReason = options.dryRun ? "dry-run" : "eligible";
  let predecessor = null;
  if (observedQueueState.entries.length > 0) {
    admissionDecision = "blocked";
    admissionReason = "blocked-by-predecessor";
    predecessor = queuePredecessor(observedQueueState);
  } else if (
    rejectBaseMoveBeforeAtomicReplay(options, initialBaseSha, observedBaseSha)
  ) {
    admissionDecision = "rejected";
    admissionReason = "base-sha-drift";
  } else if (observedHeadSha !== expectedHeadSha) {
    admissionDecision = "rejected";
    admissionReason = "head-sha-drift";
  } else if (
    !mergeableAccepted(
      observedPullRequest,
      landingMode,
      decision.projectCut?.ok === true,
    )
  ) {
    admissionDecision = "rejected";
    admissionReason = "not-mergeable-on-admission-recheck";
  }

  return { admissionDecision, admissionReason, predecessor };
}

async function admitQueueCandidate({
  decision,
  pr,
  client,
  options,
  initialBaseSha,
  landingMode,
  entry,
  result,
  orderedPullRequests,
  index,
}) {
  const expectedHeadSha = admittedHeadSha(decision, pr);
  const [observedPullRequest, observedBaseSha, observedQueueState] =
    await Promise.all([
      client.getPullRequest(pr.number, {
        attempts: options.pollMergeableAttempts,
        delayMs: options.pollMergeableDelayMs,
      }),
      client.getBranchSha(options.targetBranch),
      client.getMergeQueueState(options.targetBranch),
    ]);
  const observedHeadSha = observedPullRequest.head?.sha || "";
  const { admissionDecision, admissionReason, predecessor } =
    decideQueueAdmission({
      options,
      observedQueueState,
      initialBaseSha,
      observedBaseSha,
      observedHeadSha,
      expectedHeadSha,
      observedPullRequest,
      landingMode,
      decision,
    });

  entry.action =
    admissionDecision === "planned"
      ? "would-enqueue"
      : admissionDecision === "accepted"
        ? "enqueue"
        : "skip";
  entry.reason = admissionReason;
  entry.headSha = expectedHeadSha;
  entry.admissionReceipt = admissionReceipt({
    options,
    pr,
    expectedBaseSha: initialBaseSha,
    observedBaseSha,
    expectedHeadSha,
    observedHeadSha,
    decision: admissionDecision,
    reason: admissionReason,
    checks: decision.checks,
    approval: decision.approval,
    predecessor,
    projectCut: decision.projectCut,
  });

  if (admissionDecision === "planned") {
    result.actions.push(entry);
  } else if (admissionDecision === "accepted") {
    if (!decision.pullRequestId) {
      entry.action = "skip";
      entry.reason = "missing-pull-request-node-id";
      entry.admissionReceipt.decision = "rejected";
      entry.admissionReceipt.reason = entry.reason;
      result.skipped.push(entry);
    } else {
      try {
        const atomicAdmission = await qualifyAtomicQueueAdmission({
          client,
          options,
          pullRequest: pr,
          expectedBaseSha: initialBaseSha,
          expectedHeadSha,
          projectCut: decision.projectCut,
          sleep: delay,
          mergeableAccepted,
          root: contentRoot,
          setActiveLeaseStatus: (state) =>
            setActiveLeaseStatus(
              client,
              options.repository,
              expectedHeadSha,
              options.activeLeaseContext,
              state,
            ),
          setQueueAdmissionStatus: (state) =>
            setQueueAdmissionStatus(
              client,
              options.repository,
              expectedHeadSha,
              options.queueAdmissionContext,
              state,
            ),
        });
        Object.assign(entry, atomicAdmission.entryFields);
        const queueEntry =
          atomicAdmission.exactEntry ||
          (await client.enqueuePullRequest({
            pullRequestId: decision.pullRequestId,
            expectedHeadOid: expectedHeadSha,
          }));
        entry.action = "enqueued";
        entry.reason = atomicAdmission.exactEntry
          ? "already-enqueued-exact-head"
          : "enqueued-with-expected-head";
        entry.queueEntry = queueEntry;
        entry.admissionReceipt.reason = entry.reason;
        result.actions.push(entry);
        result.enqueued.push(entry);
      } catch (error) {
        await reconcileEnqueueError({
          client,
          options,
          pr,
          expectedHeadSha,
          entry,
          result,
          error,
        });
      }
    }
  } else {
    result.skipped.push(entry);
  }

  const activePredecessor = queuePredecessor(null, {
    queueEntryId: entry.queueEntry?.id || predecessor?.queueEntryId || "",
    pullRequestNumber: pr.number,
    headSha: expectedHeadSha,
    state:
      entry.queueEntry?.state ||
      (admissionDecision === "planned"
        ? "ADMISSION_PLANNED"
        : "ADMISSION_REJECTED"),
  });
  blockRemainingPullRequests(
    result,
    orderedPullRequests,
    index + 1,
    options,
    observedBaseSha || initialBaseSha,
    activePredecessor,
  );
}

function orderAdmissionCandidates(options, initialQueueState, pullRequests) {
  const landingMode = initialQueueState.enabled
    ? "queue"
    : options.landingMode === "queue"
      ? "queue"
      : "direct";
  const orderedPullRequests =
    landingMode === "queue"
      ? [...pullRequests].sort(
          (left, right) => Number(left.number) - Number(right.number),
        )
      : pullRequests;

  return { landingMode, orderedPullRequests };
}

function admittedHeadSha(decision, pr) {
  return decision.observedHeadSha || pr.head?.sha || "";
}

export async function runDevPrAutoMerge(optionsInput = {}, clientInput) {
  const options = normalizeOptions(optionsInput);
  if (!options.targetBranch) throw new Error("target branch is required");
  const client =
    clientInput ||
    new GitHubClient({
      token: optionsInput.token,
      repository: options.repository,
      apiUrl: optionsInput.apiUrl || "https://api.github.com",
    });
  const [pullRequests, initialBaseSha, initialQueueState] = await Promise.all([
    client.listPullRequests(options.targetBranch),
    client.getBranchSha(options.targetBranch).catch(() => ""),
    client.getMergeQueueState(options.targetBranch),
  ]);
  const { landingMode, orderedPullRequests } = orderAdmissionCandidates(
    options,
    initialQueueState,
    pullRequests,
  );
  const result = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-dev-pr-auto-merge",
    repository: options.repository.fullName,
    targetBranch: options.targetBranch,
    requestedLandingMode: options.landingMode,
    landingMode,
    dryRun: options.dryRun,
    maxMerges: options.maxMerges,
    evaluated: [],
    actions: [],
    merged: [],
    enqueued: [],
    skipped: [],
    initialBaseSha,
    finalBaseSha: initialBaseSha,
    mergeQueue: initialQueueState,
  };
  if (landingMode === "queue" && !initialQueueState.enabled) {
    blockRemainingPullRequests(
      result,
      orderedPullRequests,
      0,
      options,
      initialBaseSha,
      null,
    );
    for (const entry of result.evaluated) {
      entry.reason = "merge-queue-not-enabled";
      entry.admissionReceipt.reason = "merge-queue-not-enabled";
      entry.admissionReceipt.decision = "rejected";
    }
    return finalizePatrolResult(result);
  }

  if (landingMode === "queue" && initialQueueState.entries.length > 0) {
    blockRemainingPullRequests(
      result,
      orderedPullRequests,
      0,
      options,
      initialBaseSha,
      queuePredecessor(initialQueueState),
    );
    return finalizePatrolResult(result);
  }

  for (let index = 0; index < orderedPullRequests.length; index += 1) {
    const pr = orderedPullRequests[index];
    if (result.merged.length >= options.maxMerges) {
      const entry = {
        number: pr.number,
        title: pr.title || "",
        action: "skip",
        reason: "max-merges-reached",
      };
      result.evaluated.push(entry);
      result.skipped.push(entry);
      continue;
    }

    const decision = await evaluatePullRequest(
      pr,
      { ...options, landingMode },
      client,
    );
    const entry = evaluatedEntry(pr, decision);
    result.evaluated.push(entry);

    if (landingMode === "direct" && decision.action === "merge") {
      const mergeResult = await client.mergePullRequest(pr.number, {
        method: options.mergeMethod,
        sha: pr.head?.sha,
      });
      const mergedEntry = { ...entry, mergeSha: mergeResult.sha || "" };
      result.merged.push(mergedEntry);
      result.actions.push(mergedEntry);
      result.evaluated[result.evaluated.length - 1] = mergedEntry;
    } else if (landingMode === "direct" && decision.action === "would-merge") {
      result.merged.push(entry);
      result.actions.push(entry);
    } else if (
      landingMode === "direct" ||
      STATIC_SKIP_REASONS.has(decision.reason)
    ) {
      result.skipped.push(entry);
    } else if (decision.action === "skip") {
      entry.admissionReceipt = admissionReceipt({
        options,
        pr,
        expectedBaseSha: initialBaseSha,
        observedBaseSha: initialBaseSha,
        expectedHeadSha: admittedHeadSha(decision, pr),
        observedHeadSha: admittedHeadSha(decision, pr),
        decision: "rejected",
        reason: decision.reason,
        checks: decision.checks,
        approval: decision.approval,
        projectCut: decision.projectCut,
      });
      result.skipped.push(entry);
      blockRemainingPullRequests(
        result,
        orderedPullRequests,
        index + 1,
        options,
        initialBaseSha,
        queuePredecessor(null, {
          pullRequestNumber: pr.number,
          headSha: admittedHeadSha(decision, pr),
          state: "ADMISSION_REJECTED",
        }),
      );
      break;
    } else {
      await admitQueueCandidate({
        decision,
        pr,
        client,
        options,
        initialBaseSha,
        landingMode,
        entry,
        result,
        orderedPullRequests,
        index,
      });
      break;
    }
  }

  result.finalBaseSha = await client
    .getBranchSha(options.targetBranch)
    .catch(() => "");
  return finalizePatrolResult(result);
}
