export const BUILDCHAIN_CANDIDATE_TIMELINE_CONTRACT =
  "buildchain.candidate-timeline/v1";
export const BUILDCHAIN_CANDIDATE_TIMELINE_EVENT_CONTRACT =
  "buildchain.candidate-timeline-event/v1";

const EVENT_STATUSES = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "dependency-blocked",
  "not-required",
  "unknown",
]);

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== "",
    ),
  );
}

function finiteNumber(value, fallback = undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTiming(input = {}) {
  const startedAtMs = timestampMs(input.startedAt);
  const completedAtMs = timestampMs(input.completedAt);
  const durationMs = finiteNumber(input.durationMs);
  const measured =
    startedAtMs !== null &&
    completedAtMs !== null &&
    completedAtMs >= startedAtMs;
  return compactObject({
    startedAt: measured ? new Date(startedAtMs).toISOString() : undefined,
    completedAt: measured ? new Date(completedAtMs).toISOString() : undefined,
    durationMs:
      durationMs !== undefined && durationMs >= 0
        ? Math.round(durationMs * 1000) / 1000
        : measured
          ? completedAtMs - startedAtMs
          : undefined,
    clock: input.clock || (measured ? "wall" : "unknown"),
    precisionMs: finiteNumber(input.precisionMs, measured ? 1000 : undefined),
    authority: input.authority,
    measured,
  });
}

function normalizeAttempt(input = {}) {
  if (!input.id) {
    throw new Error("candidate timeline event attempt.id is required");
  }
  return compactObject({
    id: String(input.id),
    index: Number.isInteger(input.index) ? input.index : undefined,
    kind: input.kind || "unknown",
    mergeGroupSha: input.mergeGroupSha,
    workflowRunId:
      input.workflowRunId === undefined
        ? undefined
        : String(input.workflowRunId),
  });
}

export function normalizeCandidateTimelineEvent(input = {}) {
  if (!input.id) {
    throw new Error("candidate timeline event id is required");
  }
  if (!input.phase) {
    throw new Error(`candidate timeline event ${input.id} phase is required`);
  }
  const status = input.status || "unknown";
  if (!EVENT_STATUSES.has(status)) {
    throw new Error(
      `candidate timeline event ${input.id} has invalid status: ${status}`,
    );
  }
  const timing = normalizeTiming(input.timing);
  if (
    ["success", "failure", "cancelled"].includes(status) &&
    !timing.measured
  ) {
    throw new Error(
      `candidate timeline event ${input.id} status ${status} requires a measured interval`,
    );
  }
  return compactObject({
    contract: BUILDCHAIN_CANDIDATE_TIMELINE_EVENT_CONTRACT,
    id: String(input.id),
    attempt: normalizeAttempt(input.attempt),
    phase: String(input.phase),
    category: input.category || "gate",
    status,
    gate: input.gate
      ? compactObject({
          id: input.gate.id,
          platform: input.gate.platform,
          partition:
            input.gate.partition === undefined
              ? undefined
              : String(input.gate.partition),
        })
      : undefined,
    span: input.span
      ? compactObject({
          id: input.span.id,
          parentId: input.span.parentId,
        })
      : undefined,
    execution: input.execution
      ? compactObject({
          boundary: input.execution.boundary,
          runner: input.execution.runner,
        })
      : undefined,
    cache: input.cache
      ? compactObject({
          layer: input.cache.layer,
          outcome: input.cache.outcome,
        })
      : undefined,
    timing,
    criticalPathEligible: input.criticalPathEligible !== false,
    attributes: input.attributes || {},
  });
}

function interval(event) {
  if (!event.timing.measured || !event.criticalPathEligible) return null;
  return [
    Date.parse(event.timing.startedAt),
    Date.parse(event.timing.completedAt),
  ];
}

function intervalUnionMs(intervals) {
  const ordered = intervals
    .filter(Boolean)
    .map(([start, end]) => [start, end])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (!ordered.length) return 0;
  let total = 0;
  let [currentStart, currentEnd] = ordered[0];
  for (const [start, end] of ordered.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  return total + currentEnd - currentStart;
}

function groupIntervalSummary(events, field) {
  const values = [
    ...new Set(events.map((event) => event[field] || "unknown")),
  ].sort();
  return Object.fromEntries(
    values.map((value) => {
      const selected = events.filter(
        (event) => (event[field] || "unknown") === value,
      );
      return [
        value,
        {
          eventCount: selected.length,
          measuredEventCount: selected.filter((event) => event.timing.measured)
            .length,
          intervalUnionMs: intervalUnionMs(selected.map(interval)),
        },
      ];
    }),
  );
}

function attemptOrder(left, right) {
  const leftIndex = left.attempt.index;
  const rightIndex = right.attempt.index;
  if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex)) {
    return leftIndex - rightIndex;
  }
  return left.attempt.id.localeCompare(right.attempt.id);
}

function summarizeAttempt(events) {
  const ordered = [...events].sort(attemptOrder);
  const measured = ordered.filter(
    (event) => event.timing.measured && event.criticalPathEligible,
  );
  const intervals = measured.map(interval);
  const starts = intervals.map(([start]) => start);
  const ends = intervals.map(([, end]) => end);
  const startedAtMs = starts.length ? Math.min(...starts) : null;
  const completedAtMs = ends.length ? Math.max(...ends) : null;
  const activeUnionMs = intervalUnionMs(intervals);
  const elapsedMs =
    startedAtMs === null || completedAtMs === null
      ? null
      : completedAtMs - startedAtMs;
  const unmeasured = ordered.filter(
    (event) =>
      event.criticalPathEligible &&
      !event.timing.measured &&
      !["skipped", "dependency-blocked", "not-required"].includes(event.status),
  );
  return {
    attempt: ordered[0].attempt,
    status: ordered.some((event) => event.status === "failure")
      ? "failure"
      : ordered.some((event) => event.status === "cancelled")
        ? "cancelled"
        : unmeasured.length
          ? "incomplete"
          : "observed",
    eventCount: ordered.length,
    measuredEventCount: ordered.filter((event) => event.timing.measured).length,
    phases: groupIntervalSummary(ordered, "phase"),
    categories: groupIntervalSummary(ordered, "category"),
    criticalPath: {
      method: "attempt-wall-clock-envelope",
      status: unmeasured.length
        ? "incomplete"
        : measured.length
          ? "observed"
          : "not-observed",
      startedAt:
        startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
      completedAt:
        completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
      durationMs: elapsedMs,
      activeIntervalUnionMs: activeUnionMs,
      idleOrUnobservedMs:
        elapsedMs === null ? null : Math.max(0, elapsedMs - activeUnionMs),
      unmeasuredEventIds: unmeasured.map((event) => event.id),
      note: "The attempt envelope is wall-clock elapsed time. Interval unions avoid summing nested or parallel spans; attempts are never combined into one critical path.",
    },
  };
}

function normalizeCandidate(input = {}) {
  if (!input.sourceSha) {
    throw new Error("candidate timeline candidate.sourceSha is required");
  }
  return compactObject({
    repository: input.repository,
    baseBranch: input.baseBranch,
    sourceSha: String(input.sourceSha),
    pullRequest:
      input.pullRequest === undefined ? undefined : Number(input.pullRequest),
    mergedAt:
      timestampMs(input.mergedAt) === null
        ? undefined
        : new Date(timestampMs(input.mergedAt)).toISOString(),
  });
}

export function createCandidateTimeline({
  candidate = {},
  events = [],
  generatedAt,
} = {}) {
  const normalizedCandidate = normalizeCandidate(candidate);
  const normalizedEvents = events.map(normalizeCandidateTimelineEvent);
  const sourceDrift = normalizedEvents.filter(
    (event) =>
      event.attributes?.sourceSha &&
      event.attributes.sourceSha !== normalizedCandidate.sourceSha,
  );
  if (sourceDrift.length) {
    throw new Error(
      `candidate timeline source drift in events: ${sourceDrift.map((event) => event.id).join(", ")}`,
    );
  }
  const attemptIds = [
    ...new Set(normalizedEvents.map((event) => event.attempt.id)),
  ];
  const attempts = attemptIds
    .map((attemptId) =>
      summarizeAttempt(
        normalizedEvents.filter((event) => event.attempt.id === attemptId),
      ),
    )
    .sort((left, right) => {
      const leftIndex = left.attempt.index;
      const rightIndex = right.attempt.index;
      if (Number.isInteger(leftIndex) && Number.isInteger(rightIndex)) {
        return leftIndex - rightIndex;
      }
      return left.attempt.id.localeCompare(right.attempt.id);
    });
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_CANDIDATE_TIMELINE_CONTRACT,
    generatedAt: generatedAt || new Date().toISOString(),
    candidate: normalizedCandidate,
    summary: {
      attemptCount: attempts.length,
      eventCount: normalizedEvents.length,
      measuredEventCount: normalizedEvents.filter(
        (event) => event.timing.measured,
      ).length,
      status: attempts.some((attempt) => attempt.status === "failure")
        ? "failure"
        : attempts.some((attempt) => attempt.status === "incomplete")
          ? "incomplete"
          : "observed",
      criticalPathScope: "per-attempt-only",
    },
    attempts,
    events: normalizedEvents,
  };
}

export function formatCandidateTimelineReport(timeline) {
  const lines = [
    `Candidate ${timeline.candidate.repository || "repository"}#${timeline.candidate.pullRequest || "?"} ${timeline.candidate.sourceSha}`,
    `status=${timeline.summary.status} attempts=${timeline.summary.attemptCount} events=${timeline.summary.eventCount} measured=${timeline.summary.measuredEventCount}`,
  ];
  for (const attempt of timeline.attempts) {
    const duration = attempt.criticalPath.durationMs;
    lines.push(
      [
        `attempt=${attempt.attempt.id}`,
        `kind=${attempt.attempt.kind}`,
        `status=${attempt.status}`,
        `elapsed=${duration === null ? "unknown" : `${duration}ms`}`,
        `active=${attempt.criticalPath.activeIntervalUnionMs}ms`,
        `unmeasured=${attempt.criticalPath.unmeasuredEventIds.length}`,
      ].join(" "),
    );
    for (const [phase, summary] of Object.entries(attempt.phases)) {
      lines.push(
        `  phase=${phase} union=${summary.intervalUnionMs}ms measured=${summary.measuredEventCount}/${summary.eventCount}`,
      );
    }
  }
  return lines.join("\n");
}
