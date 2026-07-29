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
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) throw new Error(`${label} must be owner/repository`);
  return normalized;
}

const TRANSIENT_GITHUB_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_ARTIFACT_SIGNING_AUTHORITY_REF = "authority/v3/v3.0/artifact-signing";

export function resolveAuthorityDispatchRef(value) {
  const ref = required(value, "authority ref");
  return /^[0-9a-f]{40}$/u.test(ref) ? DEFAULT_ARTIFACT_SIGNING_AUTHORITY_REF : ref;
}

function retryDelayMs(attempt) {
  return Math.min(1_000 * (2 ** (attempt - 1)), 10_000);
}

export async function githubRequest(url, {
  token,
  method = "GET",
  body,
  fetchImpl = fetch,
  delayImpl = delay,
  maxAttempts = 5,
  warnImpl = console.warn,
} = {}) {
  const methodName = String(method).toUpperCase();
  const retrySafe = methodName === "GET";
  const requestedAttempts = Number(maxAttempts);
  const attemptLimit = retrySafe && Number.isSafeInteger(requestedAttempts) && requestedAttempts > 0
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
        warnImpl(`Buildchain signing authority: GitHub API GET transport failure; retry ${attempt + 1}/${attemptLimit}`);
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      if (retrySafe && TRANSIENT_GITHUB_STATUSES.has(response.status) && attempt < attemptLimit) {
        warnImpl(`Buildchain signing authority: GitHub API GET returned ${response.status}; retry ${attempt + 1}/${attemptLimit}`);
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw new Error(`GitHub API ${methodName} ${url} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch (error) {
      if (retrySafe && attempt < attemptLimit) {
        warnImpl(`Buildchain signing authority: GitHub API GET response failed to decode; retry ${attempt + 1}/${attemptLimit}`);
        await delayImpl(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
  throw new Error("GitHub API retry loop exhausted");
}

export async function dispatchArtifactSigningAuthority({
  token = process.env.BUILDCHAIN_AUTHORITY_DISPATCH_TOKEN,
  authorityRepository = process.env.BUILDCHAIN_AUTHORITY_REPOSITORY || "kungfu-systems/buildchain",
  authorityRef = process.env.BUILDCHAIN_AUTHORITY_REF,
  sourceRepository = process.env.GITHUB_REPOSITORY,
  sourceRunId = process.env.GITHUB_RUN_ID,
  sourceRunAttempt = process.env.GITHUB_RUN_ATTEMPT || "1",
  requestArtifact = process.env.BUILDCHAIN_SIGNING_REQUEST_ARTIFACT,
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA,
  resultArtifact = process.env.BUILDCHAIN_SIGNING_RESULT_ARTIFACT,
  timeoutSeconds = process.env.BUILDCHAIN_SIGNING_TIMEOUT_SECONDS || "7200",
} = {}) {
  const authToken = required(token, "Buildchain authority dispatch token");
  const authorityRepo = repository(authorityRepository, "authority repository");
  const sourceRepo = repository(sourceRepository, "source repository");
  const ref = resolveAuthorityDispatchRef(authorityRef);
  const runtime = required(runtimeSha, "Buildchain runtime SHA");
  if (!/^[0-9a-f]{40}$/u.test(runtime)) throw new Error("Buildchain runtime SHA must be exact");
  const correlationId = `${required(sourceRunId, "source run ID")}-${required(sourceRunAttempt, "source run attempt")}-${runtime.slice(0, 12)}-${required(requestArtifact, "request artifact").replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
  const resultName = required(resultArtifact, "result artifact");
  const workflow = "artifact-signing-authority.yml";
  const startedAt = Date.now() - 30_000;
  await githubRequest(`/repos/${authorityRepo}/actions/workflows/${workflow}/dispatches`, {
    token: authToken,
    method: "POST",
    body: {
      ref,
      inputs: {
        "source-repository": sourceRepo,
        "source-run-id": String(sourceRunId),
        "request-artifact-pattern": required(requestArtifact, "request artifact"),
        "result-artifact-name": resultName,
        "correlation-id": correlationId,
        "expected-runtime-sha": runtime,
      },
    },
  });
  const deadline = Date.now() + Number(timeoutSeconds) * 1000;
  let run;
  while (Date.now() < deadline) {
    const response = await githubRequest(`/repos/${authorityRepo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=50`, { token: authToken });
    run = (response.workflow_runs || []).find((entry) =>
      new Date(entry.created_at).getTime() >= startedAt &&
      String(entry.display_title || "").includes(correlationId),
    );
    if (run?.status === "completed") break;
    await delay(10_000);
  }
  if (!run || run.status !== "completed") throw new Error("timed out waiting for Buildchain signing authority");
  if (run.conclusion !== "success") throw new Error(`Buildchain signing authority failed: ${run.html_url}`);
  writeGitHubOutputs({
    "authority-run-id": String(run.id),
    "authority-run-url": run.html_url,
    "result-artifact": resultName,
    "correlation-id": correlationId,
  });
  return { runId: run.id, runUrl: run.html_url, resultArtifact: resultName, correlationId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await dispatchArtifactSigningAuthority();
  } catch (error) {
    console.error(`::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  }
}
