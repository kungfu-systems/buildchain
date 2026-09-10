import { toPosix } from "./files.js";
import path from "node:path";
import { readBuildchainLogEvents } from "../../observability/logging.js";
import { summarizeBuildchainLogEvents } from "../../observability/logging.js";
import { BUILDCHAIN_DIAGNOSTICS_CONTRACT } from "../../observability/diagnostics.js";
import { BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT } from "../../observability/diagnostics.js";
import { summarizeLifecycleObservability } from "../../observability/diagnostics.js";
export function createLifecycleManifest(context, artifacts) {
  const { frameworkLog, userLog } = context;
  const {
    manifestFiles,
    summary,
    artifactScanDurationMs,
    compilerCacheActivity,
    substages,
  } = artifacts;
  frameworkLog.info("artifact.manifest.write", {
    attributes: {
      manifestPath: toPosix(
        path.relative(context.resolvedWorkspace, context.resolvedManifestPath),
      ),
      summaryPath: toPosix(
        path.relative(context.resolvedWorkspace, context.resolvedSummaryPath),
      ),
    },
  });
  frameworkLog.info("lifecycle.end", {
    attributes: {
      stage: context.stageName,
      executed: context.executed,
      fileCount: manifestFiles.length,
    },
  });
  const events = context.resolvedLogPath
    ? readBuildchainLogEvents(context.resolvedLogPath)
    : [...frameworkLog.events, ...userLog.events];
  const observability = {
    log: {
      contract: "kungfu-buildchain-log-event",
      runId: context.logRunId,
      path: context.relativeLogPath,
      summary: context.resolvedLogPath
        ? summarizeBuildchainLogEvents(
            events.filter(
              (event) =>
                event.attributes?.buildchainLogRunId === context.logRunId,
            ),
          )
        : summarizeBuildchainLogEvents(events),
    },
  };
  const lifecycleObservability = summarizeLifecycleObservability({
    events,
    logPath: context.relativeLogPath,
    artifactScanDurationMs,
    totalBytes: summary.totalBytes,
    fileCount: summary.fileCount,
  });
  observability.lifecycle = lifecycleObservability;
  Object.assign(
    observability,
    { compilerCacheActivity },
    substages.observability,
  );
  observability.diagnostics = {
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    path: context.relativeDiagnosticsPath,
    manifestPath: context.relativeDiagnosticsManifestPath,
    eventsPath: context.relativeDiagnosticsEventsPath,
  };
  if (context.relativeProcessSummaryPath) {
    observability.process = {
      contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
      path: context.relativeProcessSummaryPath,
    };
  }
  const summaryWithObservability = { ...summary, observability };
  return {
    lifecycleObservability,
    summaryWithObservability,
    manifest: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-artifact",
      artifactName: context.artifactName,
      platform: artifacts.platform,
      git: {
        repository: context.env.GITHUB_REPOSITORY || "",
        sha: context.env.BUILDCHAIN_SOURCE_SHA || context.env.GITHUB_SHA || "",
        treeSha: context.env.BUILDCHAIN_SOURCE_TREE_SHA || "",
        runtimeSha: context.env.BUILDCHAIN_RUNTIME_SHA || "",
        ref: context.env.BUILDCHAIN_SOURCE_REF || context.env.GITHUB_REF || "",
        runId: context.env.GITHUB_RUN_ID || "",
        runAttempt: context.env.GITHUB_RUN_ATTEMPT || "",
      },
      lifecycle: {
        stage: context.stageName,
        commandSource: context.commandSource,
        executed: context.executed,
        ...substages.lifecycle,
      },
      observability,
      summary: summaryWithObservability,
      expectedArtifacts: artifacts.expectedArtifacts,
      files: manifestFiles,
    },
  };
}
