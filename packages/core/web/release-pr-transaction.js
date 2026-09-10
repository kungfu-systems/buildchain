import fs from "node:fs";
import path from "node:path";
import { recordBuildchainControlPlaneOutcome } from "../observability/logging.js";
import {
  createProductionReleasePrHandoff,
  renderProductionReleasePrSummary,
} from "./release-pr-handoff.js";
import { openProductionReleasePr } from "./release-pr-provider.js";
export function recordProductionReleasePrOutcome(
  result,
  { logPath = false } = {},
) {
  const outcome =
    result.action === "created"
      ? "created"
      : result.action === "updated"
        ? "reused"
        : result.action === "suppressed-merged-release-pr"
          ? "suppressed"
          : ["permission-denied", "app-token-unavailable", "failed"].includes(
                result.action,
              )
            ? "failed"
            : "skipped";
  return recordBuildchainControlPlaneOutcome(
    {
      domain: "release-intent",
      action: result.action,
      outcome,
      reason: result.suppressionReason || result.status,
      attributes: {
        repository: result.repository,
        channel: result.productionReleaseChannel,
        pullNumber: result.pullNumber,
        sourceSha: result.sourceSha,
      },
    },
    {
      path: logPath,
      console: false,
    },
  );
}

function classifyReleasePrError(error) {
  const message = String(error?.message || error || "");
  if (
    error?.status === 403 &&
    /not permitted to create or approve pull requests|Resource not accessible by integration|permission|forbidden/i.test(
      message,
    )
  ) {
    return "permission-denied";
  }
  return "failed";
}

export function productionReleasePrOutputs(result) {
  return {
    "release-pr-status": result.status,
    "production-release-pr-status": result.status,
    "production-release-pr-action": result.action,
    "production-release-pr": String(result.pullNumber || ""),
    "production-release-pr-url": result.pullUrl || "",
    "production-release-branch": result.branchName || "",
    "production-release-source-sha": result.sourceSha || "",
    "production-release-token-source": result.tokenSource || "",
    "production-release-app-token-status": result.appTokenStatus || "",
    "production-release-pr-summary-path": result.summaryPath,
    "production-release-pr-body-path": result.bodyPath,
  };
}

export async function reconcileProductionReleasePr(
  options,
  { open = openProductionReleasePr } = {},
) {
  const {
    stagingResult,
    mode = "auto",
    failOnError = false,
    credential,
    bodyPath,
    summaryPath,
    stepSummaryPath,
    logPath,
  } = options;
  if (!["auto", "summary-only", "disabled"].includes(mode))
    throw new Error("Release PR mode must be auto, summary-only, or disabled");
  if (typeof failOnError !== "boolean")
    throw new Error("Release PR failure policy must be boolean");
  const sourceSha = stagingResult.sourceSha || options.sourceSha;
  const request = { ...options, sourceSha };
  const handoff = createProductionReleasePrHandoff(request);
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, handoff.body + "\n");
  let result = {
    ...handoff,
    mode,
    status: mode,
    action: "skipped",
    pullNumber: "",
    pullUrl: "",
    bodyPath,
    summaryPath,
    tokenSource: {
      app: "github-app",
      fallback: "production-release-pr-token",
      workflow: "github-token",
    }[credential.source],
    appTokenStatus: credential.appStatus,
    appConfig: {
      clientIdConfigured: credential.clientConfigured,
      privateKeyConfigured: credential.privateKeyConfigured,
      prTokenConfigured: credential.fallbackConfigured,
    },
  };
  let failure;
  if (mode === "auto") {
    if (credential.appUnavailable && !credential.fallbackConfigured) {
      const message = `Production release GitHub App token is unavailable (${credential.appStatus}). Configure production-release-app-client-id and production-release-app-private-key, or provide production-release-pr-token.`;
      result = {
        ...result,
        status: "app-token-unavailable",
        action: "app-token-unavailable",
        error: { status: "", message },
      };
      if (failOnError) failure = new Error(message);
    } else {
      try {
        result = { ...result, ...(await open(request)) };
      } catch (error) {
        const status = classifyReleasePrError(error);
        result = {
          ...result,
          status,
          action: status,
          error: {
            status: error.status || "",
            message: error.message || String(error),
          },
        };
        if (status !== "permission-denied" || failOnError) failure = error;
      }
    }
  }
  // Persist the handoff on every outcome before surfacing provider failure.
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2) + "\n");
  if (stepSummaryPath)
    fs.appendFileSync(
      stepSummaryPath,
      renderProductionReleasePrSummary(result),
    );
  recordProductionReleasePrOutcome(result, { logPath });
  if (failure) throw failure;
  return result;
}
