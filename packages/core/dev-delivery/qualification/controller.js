import {
  EXACT_SHA,
  ACTIVE_STATUSES,
  text,
  newest,
  runEvidence,
  evidenceRoot,
  classifyRetryableFailure,
  normalizeDevQualificationOptions,
} from "./model.js";
function decisionBody(options, fields) {
  const body = {
    schema: "kungfu-buildchain-dev-qualification-patrol/v1",
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    observedAt: options.now,
    ...fields,
  };
  return { ...body, decisionRoot: evidenceRoot(body) };
}
function decideObservedState({
  sourceSha,
  latestExactRun,
  activeRun,
  successfulPreflight,
  priorityRuns,
}) {
  const common = {
    sourceSha,
    qualificationRun: runEvidence(latestExactRun),
    preflightRun: runEvidence(successfulPreflight),
  };
  if (
    latestExactRun?.status === "completed" &&
    latestExactRun?.conclusion === "success"
  ) {
    return {
      ...common,
      state: "qualified",
      action: "none",
      reason: "latest-source-already-qualified",
      pendingSha: null,
      activeRun: null,
      priorityRuns: priorityRuns.map(runEvidence),
    };
  }
  if (priorityRuns.length > 0) {
    return {
      ...common,
      state: "waiting-priority",
      action: "none",
      reason: "alpha-or-release-workflow-active",
      pendingSha: sourceSha,
      activeRun: runEvidence(activeRun),
      priorityRuns: priorityRuns.map(runEvidence),
    };
  }
  if (activeRun) {
    const activeIsLatest = text(activeRun.head_sha) === sourceSha;
    return {
      ...common,
      state: "running",
      action: "none",
      reason: activeIsLatest
        ? "latest-source-running"
        : "newer-source-coalesced",
      pendingSha: activeIsLatest ? null : sourceSha,
      activeRun: runEvidence(activeRun),
      priorityRuns: [],
    };
  }
  if (!successfulPreflight) {
    return {
      ...common,
      state: "waiting-preflight",
      action: "none",
      reason: "latest-source-preflight-not-qualified",
      pendingSha: sourceSha,
      activeRun: null,
      preflightRun: null,
      priorityRuns: [],
    };
  }
  if (
    latestExactRun?.status === "completed" &&
    latestExactRun?.conclusion !== "success"
  ) {
    return undefined;
  }
  return {
    ...common,
    state: "dispatch-ready",
    action: "dispatch",
    reason: "latest-source-preflight-qualified",
    pendingSha: sourceSha,
    activeRun: null,
    qualificationRun: null,
    priorityRuns: [],
  };
}
async function decideFailedRun({
  options,
  client,
  sourceSha,
  latestExactRun,
  successfulPreflight,
}) {
  const jobs = await client.listRunJobs(
    latestExactRun.id,
    latestExactRun.run_attempt || 1,
  );
  const classification = classifyRetryableFailure(latestExactRun, jobs);
  const attempt = Number(latestExactRun.run_attempt || 1);
  const retryReady = classification.retryable && attempt < options.maxAttempts;
  return {
    state: retryReady ? "retry-ready" : "blocked",
    action: retryReady ? "rerun-failed-jobs" : "none",
    reason:
      classification.retryable && !retryReady
        ? "bounded-retry-exhausted"
        : classification.reason,
    sourceSha,
    pendingSha: retryReady ? sourceSha : null,
    activeRun: null,
    qualificationRun: runEvidence(latestExactRun),
    preflightRun: runEvidence(successfulPreflight),
    priorityRuns: [],
    retryClassification: classification,
  };
}
export async function runDevQualificationPatrol(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeDevQualificationOptions(optionsInput);
  const client = clientInput;
  if (!client)
    throw new Error("Dev qualification requires an explicit provider client");
  const [sourceSha, devRuns, preflightRuns, ...priorityRunSets] =
    await Promise.all([
      client.resolveBranch(options.sourceBranch),
      client.listWorkflowRuns(options.devWorkflowPath, options.sourceBranch),
      client.listWorkflowRuns(
        options.preflightWorkflowPath,
        options.sourceBranch,
      ),
      ...options.priorityWorkflowPaths.map((workflow) =>
        client.listWorkflowRuns(workflow, undefined, { activeOnly: true }),
      ),
    ]);
  if (!EXACT_SHA.test(sourceSha))
    throw new Error(`source branch resolved invalid SHA ${sourceSha}`);

  const exactRuns = devRuns.filter((run) => text(run.head_sha) === sourceSha);
  const latestExactRun = newest(exactRuns);
  const activeRun = newest(
    devRuns.filter((run) => ACTIVE_STATUSES.has(text(run.status))),
  );
  const successfulPreflight = newest(
    preflightRuns.filter(
      (run) =>
        text(run.head_sha) === sourceSha &&
        text(run.status) === "completed" &&
        text(run.conclusion) === "success",
    ),
  );
  const priorityRuns = priorityRunSets
    .flat()
    .filter((run) => ACTIVE_STATUSES.has(text(run.status)));
  let fields = decideObservedState({
    sourceSha,
    latestExactRun,
    activeRun,
    successfulPreflight,
    priorityRuns,
  });
  if (!fields) {
    fields = await decideFailedRun({
      options,
      client,
      sourceSha,
      latestExactRun,
      successfulPreflight,
    });
  }

  if (options.expectedAction && fields.action !== options.expectedAction) {
    throw new Error(
      `qualification controller action changed: expected ${options.expectedAction}, observed ${fields.action}`,
    );
  }
  if (options.expectedSourceSha && sourceSha !== options.expectedSourceSha) {
    throw new Error(
      `qualification controller source changed: expected ${options.expectedSourceSha}, observed ${sourceSha}`,
    );
  }
  let mutation = null;
  if (options.mutationAuthorized && fields.action === "dispatch") {
    mutation = await client.dispatchWorkflow(
      options.devWorkflowPath,
      options.sourceBranch,
      {
        ...options.dispatchInputs,
        "source-sha": sourceSha,
      },
    );
  } else if (
    options.mutationAuthorized &&
    fields.action === "rerun-failed-jobs"
  ) {
    mutation = await client.rerunFailedJobs(latestExactRun.id);
  }
  return decisionBody(options, {
    ...fields,
    mutationAuthorized: options.mutationAuthorized,
    mutation,
  });
}
