#!/usr/bin/env node
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runLifecycle } from "./run-lifecycle-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function parseList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readBooleanArg(name, fallback = "false") {
  return readArg(name, fallback) === "true";
}

function readNumberArg(name, fallback) {
  return Number(readArg(name, String(fallback)) || fallback);
}

export function runLifecycleCli() {
  return runLifecycle({
    cwd: readArg("cwd", process.cwd()),
    stageName: readArg("stage"),
    command: process.env.BUILDCHAIN_COMMAND || "",
    required: readArg("required", "false") === "true",
    manifestPath: readArg("manifest-path", ".buildchain/artifacts/manifest.json"),
    summaryPath: readArg("summary-path", ".buildchain/artifacts/summary.json"),
    artifactName: readArg("artifact-name", "buildchain-artifact"),
    manifestArtifactName: readArg("manifest-artifact-name", ""),
    diagnosticsArtifactName: readArg("diagnostics-artifact-name", ""),
    platformId: readArg("platform-id", os.platform()),
    platformName: readArg("platform-name", readArg("platform-id", os.platform())),
    artifactPaths: parseList(process.env.BUILDCHAIN_ARTIFACT_PATHS || ""),
    expectedArtifactsJson: process.env.BUILDCHAIN_EXPECTED_ARTIFACTS_JSON || "",
    processSummaryPath: readArg("process-summary", process.env.BUILDCHAIN_PROCESS_SUMMARY_PATH || ""),
    processSamplesPath: readArg("process-samples", process.env.BUILDCHAIN_PROCESS_SAMPLES_PATH || ".buildchain/diagnostics/process-samples.jsonl"),
    sampleProcessTree: readBooleanArg("sample-process-tree", process.env.BUILDCHAIN_SAMPLE_PROCESS_TREE || "false"),
    processSampleIntervalMs: readNumberArg("process-sample-interval-ms", process.env.BUILDCHAIN_PROCESS_SAMPLE_INTERVAL_MS || 15000),
    requestedParallelism: readNumberArg("requested-parallelism", process.env.BUILDCHAIN_REQUESTED_PARALLELISM || 0),
    processSummaryRequired: readBooleanArg("process-summary-required", process.env.BUILDCHAIN_PROCESS_SUMMARY_REQUIRED || "true"),
    workspace: process.cwd(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLifecycleCli();
}
