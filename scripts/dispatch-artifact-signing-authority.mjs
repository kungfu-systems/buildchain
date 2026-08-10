#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function repository(value, label) {
  const normalized = required(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized))
    throw new Error(`${label} must be owner/repository`);
  return normalized;
}

const TRANSIENT_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_ARTIFACT_SIGNING_AUTHORITY_REF =
  "authority/v3/v3.0/artifact-signing";
const AUTHORITY_WORKFLOW = "artifact-signing-authority.yml";

export function resolveAuthorityDispatchRef(value) {
  const ref = required(value, "authority ref");
  return /^[0-9a-f]{40}$/u.test(ref)
    ? DEFAULT_ARTIFACT_SIGNING_AUTHORITY_REF
    : ref;
}

export async function resolveArtifactSigningAuthorityRuntime({
  authorityRepository,
  authorityRef,
  token,
  requestImpl = githubRequest,
}) {
  const authorityRepo = repository(authorityRepository, "authority repository");
  const ref = resolveAuthorityDispatchRef(authorityRef);
  const encodedRef = ref.split("/").map(encodeURIComponent).join("/");
  const response = await requestImpl(
    `/repos/${authorityRepo}/git/ref/heads/${encodedRef}`,
    { token: required(token, "Buildchain authority dispatch token") },
  );
  if (response?.object?.type !== "commit") {
    throw new Error(
      "Buildchain signing authority ref does not resolve to a commit",
    );
  }
  const sha = String(response.object.sha || "");
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error("Buildchain signing authority runtime SHA must be exact");
  }
  return { ref, sha };
}

function retryDelayMs(attempt) {
  return Math.min(1_000 * 2 ** (attempt - 1), 10_000);
}

function authorityError(message, outputs = {}) {
  const error = new Error(message);
  error.authorityOutputs = outputs;
  return error;
}

export function validateArtifactSigningAuthorityRun(
  run,
  { authorityRepository, authorityRuntimeSha, expectedTitle },
) {
  if (!run || typeof run !== "object") {
    throw new Error("Buildchain signing authority run is missing");
  }
  if (String(run.display_title || "") !== expectedTitle) {
    throw new Error("Buildchain signing authority correlation mismatch");
  }
  if (String(run.event || "") !== "workflow_dispatch") {
    throw new Error("Buildchain signing authority event mismatch");
  }
  if (String(run.head_sha || "") !== authorityRuntimeSha) {
    throw new Error("Buildchain signing authority runtime SHA mismatch");
  }
  if (
    run.repository?.full_name &&
    String(run.repository.full_name) !== authorityRepository
  ) {
    throw new Error("Buildchain signing authority repository mismatch");
  }
  const runPath = String(run.path || "").split("@", 1)[0];
  if (run.path && runPath !== `.github/workflows/${AUTHORITY_WORKFLOW}`) {
    throw new Error("Buildchain signing authority workflow path mismatch");
  }
  return run;
}

export async function githubRequest(
  url,
  {
    token,
    method = "GET",
    body,
    fetchImpl = fetch,
    delayImpl = delay,
    maxAttempts = 5,
    warnImpl = console.warn,
  } = {},
) {
  const methodName = String(method).toUpperCase();
  const retrySafe = methodName === "GET";
  const requestedAttempts = Number(maxAttempts);
  const attemptLimit =
    retrySafe &&
    Number.isSafeInteger(requestedAttempts) &&
    requestedAttempts > 0
      ? requestedAttempts
      : 1;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${url}`, {
        method: methodName,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kungfu-buildchain-artifact-signing",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (retrySafe && attempt < attemptLimit) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET transport failure; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      if (
        retrySafe &&
        TRANSIENT_GITHUB_STATUSES.has(response.status) &&
        attempt < attemptLimit
      ) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET returned ${response.status}; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw new Error(
        `GitHub API ${methodName} ${url} failed (${response.status}): ${text.slice(0, 500)}`,
      );
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch (error) {
      if (retrySafe && attempt < attemptLimit) {
        warnImpl(
          `Buildchain signing authority: GitHub API GET response failed to decode; retry ${attempt + 1}/${attemptLimit}`,
        );
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error("GitHub API retry loop exhausted");
}

async function pollArtifactSigningAuthorityRun({
  authorityRepository,
  token,
  authorityRuntimeSha,
  expectedTitle,
  startedAtMs,
  deadline,
  baseOutputs,
  requestImpl,
  delayImpl,
  nowImpl,
}) {
  let run;
  while (nowImpl() < deadline) {
    const response = await requestImpl(
      `/repos/${authorityRepository}/actions/workflows/${AUTHORITY_WORKFLOW}/runs?event=workflow_dispatch&per_page=50`,
      { token },
    );
    const matches = (response.workflow_runs || []).filter(
      (entry) =>
        new Date(entry.created_at).getTime() >= startedAtMs - 30_000 &&
        String(entry.display_title || "") === expectedTitle,
    );
    if (matches.length > 1) {
      throw authorityError(
        "multiple Buildchain signing authority runs share one correlation",
        { ...baseOutputs, "authority-status": "failed" },
      );
    }
    if (matches.length === 1) {
      try {
        run = validateArtifactSigningAuthorityRun(matches[0], {
          authorityRepository,
          authorityRuntimeSha,
          expectedTitle,
        });
      } catch (error) {
        throw authorityError(error.message, {
          ...baseOutputs,
          "authority-run-id": String(matches[0].id || ""),
          "authority-run-url": String(matches[0].html_url || ""),
          "authority-status": "failed",
        });
      }
    }
    if (run?.status === "completed") return run;
    await delayImpl(10_000);
  }
  throw authorityError("timed out waiting for Buildchain signing authority", {
    ...baseOutputs,
    "authority-run-id": String(run?.id || ""),
    "authority-run-url": String(run?.html_url || ""),
    "authority-status": "timed-out",
    "authority-conclusion": String(run?.conclusion || "timed-out"),
    "controller-completed-at": new Date(nowImpl()).toISOString(),
  });
}

function successfulAuthorityResult({
  run,
  baseOutputs,
  resultArtifact,
  correlationId,
  controllerStartedAt,
  completedAt,
}) {
  if (run.conclusion !== "success") {
    const status = run.conclusion === "cancelled" ? "cancelled" : "failed";
    throw authorityError(
      `Buildchain signing authority failed: ${run.html_url}`,
      {
        ...baseOutputs,
        "authority-run-id": String(run.id),
        "authority-run-url": String(run.html_url || ""),
        "authority-status": status,
        "authority-conclusion": String(run.conclusion || status),
        "controller-completed-at": completedAt,
      },
    );
  }
  return {
    outputs: {
      ...baseOutputs,
      "authority-run-id": String(run.id),
      "authority-run-url": String(run.html_url || ""),
      "authority-status": "succeeded",
      "authority-conclusion": "success",
      "controller-completed-at": completedAt,
    },
    result: {
      runId: run.id,
      runUrl: run.html_url,
      authorityRuntimeSha: baseOutputs["authority-runtime-sha"],
      resultArtifact,
      correlationId,
      status: "succeeded",
      startedAt: controllerStartedAt,
      completedAt,
    },
  };
}

export async function dispatchArtifactSigningAuthority({
  token = process.env.BUILDCHAIN_AUTHORITY_DISPATCH_TOKEN,
  authorityRepository = process.env.BUILDCHAIN_AUTHORITY_REPOSITORY ||
    "kungfu-systems/buildchain",
  authorityRef = process.env.BUILDCHAIN_AUTHORITY_REF,
  sourceRepository = process.env.GITHUB_REPOSITORY,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
  requestArtifact = process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT,
  requestRoot = process.env.BUILDCHAIN_SIGNING_REQUEST_ROOT_DIGEST,
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  resultArtifact = process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT,
  correlationId = process.env.BUILDCHAIN_AUTHORITY_CORRELATION_ID || "",
  timeoutSeconds = process.env.BUILDCHAIN_SIGNING_TIMEOUT_SECONDS || "7200",
  requestImpl = githubRequest,
  delayImpl = delay,
  nowImpl = () => Date.now(),
} = {}) {
  const authToken = required(token, "Buildchain authority dispatch token");
  const authorityRepo = repository(authorityRepository, "authority repository");
  const sourceRepo = repository(sourceRepository, "source repository");
  const ref = resolveAuthorityDispatchRef(authorityRef);
  const runtime = required(runtimeSha, "Buildchain runtime SHA");
  if (!/^[0-9a-f]{40}$/u.test(runtime))
    throw new Error("Buildchain runtime SHA must be exact");
  const runId = required(sourceRunId, "source run ID");
  const runAttempt = required(sourceRunAttempt, "source run attempt");
  if (!/^[1-9][0-9]*$/u.test(runAttempt)) {
    throw new Error("source run attempt must be a positive integer");
  }
  const requestName = required(requestArtifact, "request artifact");
  const requestRootDigest = required(requestRoot, "request root");
  if (!/^sha256:[0-9a-f]{64}$/u.test(requestRootDigest)) {
    throw new Error("request root must be a canonical sha256 root");
  }
  const correlation = required(
    correlationId ||
      `${runId}-${runAttempt}-${runtime.slice(0, 12)}-${requestName.replace(/[^A-Za-z0-9._-]+/gu, "-")}`,
    "correlation ID",
  );
  const resultName = required(resultArtifact, "result artifact");
  const timeout = Number(timeoutSeconds);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Buildchain signing timeout must be positive");
  }
  const controllerStartedAtMs = nowImpl();
  const controllerStartedAt = new Date(controllerStartedAtMs).toISOString();
  const baseOutputs = {
    "result-artifact": resultName,
    "correlation-id": correlation,
    "controller-started-at": controllerStartedAt,
  };
  try {
    const authorityRuntime = await resolveArtifactSigningAuthorityRuntime({
      authorityRepository: authorityRepo,
      authorityRef: ref,
      token: authToken,
      requestImpl,
    });
    baseOutputs["authority-runtime-sha"] = authorityRuntime.sha;
    await requestImpl(
      `/repos/${authorityRepo}/actions/workflows/${AUTHORITY_WORKFLOW}/dispatches`,
      {
        token: authToken,
        method: "POST",
        body: {
          ref: authorityRuntime.ref,
          inputs: {
            "source-repository": sourceRepo,
            "source-run-id": runId,
            "source-run-attempt": runAttempt,
            "request-artifact-pattern": requestName,
            "expected-request-root": requestRootDigest,
            "result-artifact-name": resultName,
            "correlation-id": correlation,
            "expected-runtime-sha": runtime,
          },
        },
      },
    );
    const expectedTitle = `Sign ${sourceRepo} run ${runId} (${correlation})`;
    const run = await pollArtifactSigningAuthorityRun({
      authorityRepository: authorityRepo,
      token: authToken,
      authorityRuntimeSha: authorityRuntime.sha,
      expectedTitle,
      startedAtMs: controllerStartedAtMs,
      deadline: controllerStartedAtMs + timeout * 1000,
      baseOutputs,
      requestImpl,
      delayImpl,
      nowImpl,
    });
    const completedAt = new Date(nowImpl()).toISOString();
    const completed = successfulAuthorityResult({
      run,
      baseOutputs,
      resultArtifact: resultName,
      correlationId: correlation,
      controllerStartedAt,
      completedAt,
    });
    writeGitHubOutputs(completed.outputs);
    return completed.result;
  } catch (error) {
    if (!error.authorityOutputs) {
      error.authorityOutputs = {
        ...baseOutputs,
        "authority-status": "failed",
        "authority-conclusion": "controller-error",
        "controller-completed-at": new Date(nowImpl()).toISOString(),
      };
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await dispatchArtifactSigningAuthority();
  } catch (error) {
    if (error?.authorityOutputs) writeGitHubOutputs(error.authorityOutputs);
    console.error(
      `::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
