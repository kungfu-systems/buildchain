import { urlsFromResult } from "./release-pr-summary.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { upsertIssueComment } from "../providers/github-issue-comment.js";

export const RELEASE_FEEDBACK_MARKERS = {
  staging: "<!-- buildchain:web-surface-release-feedback:staging -->",
  production: "<!-- buildchain:web-surface-release-feedback:production -->",
};

function nowIso() {
  return new Date().toISOString();
}

function optionalString(value = "") {
  return String(value || "").trim();
}

function asBool(value) {
  return value === true || value === "true";
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runUrl({ serverUrl = "", repository = "", runId = "" } = {}) {
  if (!serverUrl || !repository || !runId) return "";
  return `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${runId}`;
}

function privateActorRef(actor = "", kind = "actor") {
  const value = optionalString(actor);
  if (!value) return "";
  const digest = crypto
    .createHash("sha256")
    .update(`${kind}:${value}`)
    .digest("hex")
    .slice(0, 16);
  return `private-ref:sha256:${digest}`;
}

export function normalizeActorIdentity(
  actor = "",
  { privacyMode = "public", kind = "actor" } = {},
) {
  const value = optionalString(actor);
  if (!value) return "";
  if (privacyMode === "redacted") return `${kind}:redacted`;
  if (privacyMode === "private-ref") return privateActorRef(value, kind);
  return value;
}

function inferStatus({ result, applyOutcome = "", jobStatus = "" } = {}) {
  if (result?.status) return result.status;
  if (applyOutcome === "success" || jobStatus === "success") return "success";
  if (applyOutcome || jobStatus) return "failure";
  return "unknown";
}

function eventTimestamp(payload = {}) {
  return (
    payload.pull_request?.merged_at ||
    payload.pull_request?.updated_at ||
    payload.head_commit?.timestamp ||
    payload.repository?.pushed_at ||
    nowIso()
  );
}

async function githubJson({
  apiUrl = "https://api.github.com",
  token,
  url,
  fetchImpl = fetch,
}) {
  if (!token)
    throw new Error(
      "GITHUB_TOKEN is required to resolve associated pull requests",
    );
  const response = await fetchImpl(
    url.startsWith("http") ? url : `${apiUrl.replace(/\/$/, "")}${url}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub API request failed: HTTP ${response.status}`);
  }
  return response.json();
}

export async function resolveFeedbackTarget({
  payload = {},
  repository = "",
  commitSha = "",
  releasePullNumber = "",
  releasePullSource = "",
  apiUrl = "https://api.github.com",
  token = "",
  fetchImpl = fetch,
} = {}) {
  const explicitNumber = optionalString(releasePullNumber);
  if (explicitNumber) {
    return {
      shouldComment: true,
      pullNumber: Number(explicitNumber),
      source: "release-intent",
      sourceBranch: releasePullSource,
    };
  }

  const payloadPull = payload.pull_request;
  if (payloadPull?.number) {
    return {
      shouldComment: true,
      pullNumber: Number(payloadPull.number),
      source: "event-pull-request",
      sourceBranch: payloadPull.head?.ref || "",
    };
  }

  if (!repository || !commitSha || !repository.includes("/")) {
    return { shouldComment: false, reason: "missing-repository-or-commit" };
  }

  const [owner, repo] = repository.split("/");
  const associated = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    url: `/repos/${owner}/${repo}/commits/${commitSha}/pulls?per_page=100`,
  });
  const sameRepo = `${owner}/${repo}`;
  const candidates = associated.filter(
    (pull) =>
      pull.merged_at &&
      pull.base?.ref === "main" &&
      pull.head?.repo?.full_name === sameRepo,
  );
  if (candidates.length !== 1) {
    return {
      shouldComment: false,
      reason:
        candidates.length === 0
          ? "no-associated-merged-pr"
          : "multiple-associated-merged-prs",
      candidatePulls: candidates.map((pull) => pull.number),
    };
  }
  return {
    shouldComment: true,
    pullNumber: Number(candidates[0].number),
    source: "associated-merged-pr",
    sourceBranch: candidates[0].head?.ref || "",
  };
}

export function createWebSurfaceReleasePassport({
  channel = "staging",
  repository = "",
  productName = "",
  sourceSha = "",
  result = undefined,
  status = "unknown",
  applyOutcome = "",
  jobStatus = "",
  runId = "",
  runAttempt = "",
  runUrl: workflowRunUrl = "",
  runtimeSha = "",
  rollbackPointer = "",
  payload = {},
  sourceEvent = "",
  target = {},
  gate = {},
  privacyMode = "public",
  actor = "",
  triggeringActor = "",
  runnerActor = "",
  oidcDeployIdentity = "",
  productionPreflight = undefined,
  healthCheck = undefined,
} = {}) {
  const normalizedStatus =
    inferStatus({ result, applyOutcome, jobStatus }) || status;
  const decisionType =
    channel === "production"
      ? "release-pr-merge-or-manual-approval"
      : "main-merge-staging";
  const normalizedResult = result || {};
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-release-passport",
    generatedAt: nowIso(),
    product: {
      name: optionalString(
        productName || repository.split("/").pop() || "web-surface",
      ),
      repository: optionalString(repository),
      type: "web-surface",
    },
    release: {
      channel: optionalString(channel),
      sourceSha: optionalString(normalizedResult.sourceSha || sourceSha),
      status: normalizedStatus,
      url: optionalString(normalizedResult.url),
      urls: urlsFromResult(normalizedResult),
      artifactHash: optionalString(normalizedResult.artifactHash),
      target: optionalString(normalizedResult.target),
      manifestKey: optionalString(normalizedResult.manifestKey),
      runtimeSha: optionalString(
        runtimeSha || normalizedResult.manifest?.runtimeId,
      ),
      rollbackPointer: optionalString(
        rollbackPointer || normalizedResult.manifest?.rollbackPointer,
      ),
    },
    responsibility: {
      privacyMode,
      humanDecisionActor: normalizeActorIdentity(actor, {
        privacyMode,
        kind: "human-decision-actor",
      }),
      triggerActor: normalizeActorIdentity(triggeringActor || actor, {
        privacyMode,
        kind: "trigger-actor",
      }),
      runnerExecutionActor: normalizeActorIdentity(runnerActor || actor, {
        privacyMode,
        kind: "runner-execution-actor",
      }),
      oidcDeployIdentity: optionalString(oidcDeployIdentity),
      decisionType,
      decidedAt: eventTimestamp(payload),
      sourceEvent: optionalString(
        sourceEvent || payload.action || (payload.ref ? "push" : ""),
      ),
      pullRequest: target.pullNumber ? Number(target.pullNumber) : null,
      mergeCommit: optionalString(sourceSha),
      requiredGateEvidence: {
        label: optionalString(gate.label),
        headPrefix: optionalString(gate.headPrefix),
        sourceBranch: optionalString(target.sourceBranch),
        targetResolution: optionalString(target.source || target.reason),
      },
    },
    workflow: {
      runId: optionalString(runId),
      runAttempt: optionalString(runAttempt),
      url: optionalString(workflowRunUrl),
      applyOutcome: optionalString(applyOutcome),
      jobStatus: optionalString(jobStatus),
    },
    evidence: {
      applyResultBound: Boolean(result),
      failureContext:
        normalizedStatus === "success"
          ? ""
          : optionalString(applyOutcome || jobStatus || "missing-apply-result"),
      productionPreflight,
      healthCheck,
    },
  };
}

export function renderWebSurfaceReleaseFeedbackComment({
  channel = "staging",
  passport = {},
  target = {},
  passportArtifact = "",
} = {}) {
  const marker =
    RELEASE_FEEDBACK_MARKERS[channel] ||
    `<!-- buildchain:web-surface-release-feedback:${channel} -->`;
  const release = passport.release || {};
  const urls =
    release.urls && Object.keys(release.urls).length > 0
      ? release.urls
      : release.url
        ? { default: release.url }
        : {};
  const urlLines = Object.entries(urls).map(
    ([surface, url]) => `- ${surface}: ${url}`,
  );
  const status = release.status || "unknown";
  const title =
    channel === "production"
      ? "Buildchain production deploy"
      : "Buildchain staging deploy";
  const failure = passport.evidence?.failureContext
    ? [`- Failure context: \`${passport.evidence.failureContext}\``]
    : [];
  const targetLine = target.pullNumber
    ? `- Comment target: PR #${target.pullNumber}`
    : "";
  const preflight = passport.evidence?.productionPreflight?.status
    ? `- Production preflight: \`${passport.evidence.productionPreflight.status}\``
    : "";
  const health = passport.evidence?.healthCheck?.status
    ? `- Health check: \`${passport.evidence.healthCheck.status}\``
    : "";
  return [
    marker,
    `## ${title}`,
    "",
    `- Status: \`${status}\``,
    ...urlLines,
    `- Source: \`${release.sourceSha || ""}\``,
    `- Artifact: \`${release.artifactHash || ""}\``,
    `- Target: \`${release.target || ""}\``,
    `- Rollback pointer: \`${release.rollbackPointer || ""}\``,
    preflight,
    health,
    `- Run: ${passport.workflow?.url || ""}`,
    `- Passport artifact: \`${passportArtifact || "buildchain-web-surface-release-passport"}\``,
    targetLine,
    ...failure,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function reportWebRelease(
  {
    channel,
    event,
    request,
    runtime,
    intent,
    result,
    productionPreflight,
    healthCheck,
    applyOutcome,
    jobStatus,
    outputPath,
    token,
  },
  { fetchImpl = fetch } = {},
) {
  const { payload, repository } = event;
  const sourceSha = optionalString(result?.sourceSha || event.sha);
  const target = await resolveFeedbackTarget({
    payload,
    repository,
    commitSha: sourceSha,
    releasePullNumber: intent.productionReleasePr,
    releasePullSource: intent.productionReleaseSource,
    apiUrl: event.apiUrl,
    token,
    fetchImpl,
  });
  const passport = createWebSurfaceReleasePassport({
    channel,
    repository,
    sourceSha,
    result,
    applyOutcome,
    jobStatus,
    runId: event.runId,
    runAttempt: event.runAttempt,
    runUrl: runUrl({
      serverUrl: event.serverUrl,
      repository,
      runId: event.runId,
    }),
    runtimeSha: runtime.sha,
    rollbackPointer: runtime.rollbackPointer,
    payload,
    sourceEvent: event.name,
    target,
    gate: {
      label: request["production-release-label"],
      headPrefix: request["production-release-head-prefix"],
    },
    privacyMode: request["release-feedback-actor-privacy"] || "public",
    actor: event.actor,
    triggeringActor: event.triggeringActor,
    runnerActor: event.runner || event.actor,
    oidcDeployIdentity: request[`${channel}-aws-role-arn`],
    productionPreflight,
    healthCheck,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(passport, null, 2) + "\n");
  if (!target.shouldComment)
    return {
      passport,
      target,
      comment: { action: "skipped", reason: target.reason },
    };
  const body = renderWebSurfaceReleaseFeedbackComment({
    channel,
    passport,
    target,
    passportArtifact: `buildchain-web-surface-${channel}-release-passport`,
  });
  const comment = await upsertIssueComment({
    apiUrl: event.apiUrl,
    token,
    repository,
    issueNumber: target.pullNumber,
    body,
    marker: RELEASE_FEEDBACK_MARKERS[channel],
    fetchImpl,
  });
  return { passport, target, comment };
}
