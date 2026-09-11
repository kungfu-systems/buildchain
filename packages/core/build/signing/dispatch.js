import { githubRequest } from "../../providers/github/signing-request.js";
import { setTimeout as delay } from "node:timers/promises";

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

const AUTHORITY_WORKFLOW = "public-release-signing-authority.yml";

export function resolveAuthorityDispatchRef(value = "v4") {
  if (!["v4", "v4-alpha"].includes(value))
    throw new Error("Signing entry must use a public floating channel");
  return value;
}

function authorityError(message, outputs = {}) {
  const error = new Error(message);
  error.authorityOutputs = outputs;
  return error;
}

export function validateArtifactSigningAuthorityRun(
  run,
  { authorityRepository, expectedTitle },
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

async function pollArtifactSigningAuthorityRun({
  authorityRepository,
  token,
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
  token,
  authorityRepository = "kungfu-systems/buildchain",
  authorityRef = "v4",
  sourceRepository,
  sourceRunId,
  sourceRunAttempt = "1",
  requestArtifact,
  requestRoot,
  runtimeSha,
  resultArtifact,
  correlationId = "",
  timeoutSeconds = "7200",
  requestImpl = githubRequest,
  delayImpl = delay,
  nowImpl = () => Date.now(),
} = {}) {
  const authToken = required(token, "Buildchain authority dispatch token");
  const authorityRepo = repository(authorityRepository, "authority repository");
  const sourceRepo = repository(sourceRepository, "source repository");
  const ref = resolveAuthorityDispatchRef(authorityRef);
  const runtime = required(runtimeSha, "Buildchain runtime SHA");
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
    baseOutputs["authority-runtime-sha"] = runtime;
    await requestImpl(
      `/repos/${authorityRepo}/actions/workflows/${AUTHORITY_WORKFLOW}/dispatches`,
      {
        token: authToken,
        method: "POST",
        body: {
          ref,
          inputs: {
            "source-repository": sourceRepo,
            "source-run-id": runId,
            "source-run-attempt": runAttempt,
            "request-artifact-pattern": requestName,
            "expected-request-root": requestRootDigest,
            "result-artifact-name": resultName,
            "correlation-id": correlation,
            "runtime-ref": runtime,
          },
        },
      },
    );
    const expectedTitle = `Sign ${sourceRepo} run ${runId} (${correlation})`;
    const run = await pollArtifactSigningAuthorityRun({
      authorityRepository: authorityRepo,
      token: authToken,
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
    return { ...completed.result, outputs: completed.outputs };
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
