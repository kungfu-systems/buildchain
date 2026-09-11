import path from "node:path";
import { runLifecycle } from "./transaction.js";
export async function runLifecycleAction(core, env) {
  const getInput = (name) => core.getInput(name);
  const setOutput = (name, value) => core.setOutput(name, value);
  const manifestPath =
    getInput("manifest-path") || ".buildchain/artifacts/manifest.json";
  const summaryPath =
    getInput("summary-path") || ".buildchain/artifacts/summary.json";
  const diagnosticsPath = getInput("diagnostics-path") || "";
  const manifest = runLifecycle({
    cwd: path.resolve(env.GITHUB_WORKSPACE, getInput("cwd") || "."),
    stageName: getInput("stage") || "build",
    command: getInput("command") || "",
    required: getInput("required") === "true",
    timeoutMinutes: Number(getInput("timeout-minutes") || 120),
    manifestPath,
    summaryPath,
    diagnosticsPath,
    artifactName: getInput("artifact-name") || "buildchain-artifact",
    manifestArtifactName: getInput("manifest-artifact-name") || "",
    diagnosticsArtifactName: getInput("diagnostics-artifact-name") || "",
    platformId: getInput("platform-id") || env.RUNNER_OS || process.platform,
    platformName:
      getInput("platform-name") ||
      getInput("platform-id") ||
      env.RUNNER_OS ||
      process.platform,
    artifactPaths: String(getInput("artifact-paths") || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    expectedArtifactsJson: getInput("expected-artifacts-json") || "",
    processSummaryPath: getInput("process-summary-path") || "",
    processSamplesPath:
      getInput("process-samples-path") ||
      ".buildchain/diagnostics/process-samples.jsonl",
    sampleProcessTree: getInput("sample-process-tree") === "true",
    processSampleIntervalMs: Number(
      getInput("process-sample-interval-ms") || 15000,
    ),
    requestedParallelism: Number(getInput("requested-parallelism") || 0),
    processSummaryRequired: getInput("process-summary-required") !== "false",
    substageEvidencePath: getInput("substage-evidence-path") || "",
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    env,
  });
  setOutput("manifest-path", manifestPath);
  setOutput("summary-path", summaryPath);
  setOutput("artifact-name", manifest.artifactName);
  setOutput("artifact-file-count", String(manifest.summary.fileCount));
  setOutput("artifact-total-bytes", String(manifest.summary.totalBytes));
  setOutput(
    "artifact-summary-json",
    JSON.stringify({
      contract: manifest.summary.contract,
      artifactName: manifest.summary.artifactName,
      platform: manifest.summary.platform,
      fileCount: manifest.summary.fileCount,
      totalBytes: manifest.summary.totalBytes,
      digest: manifest.summary.digest,
    }),
  );
  setOutput("expected-artifacts-ok", String(manifest.expectedArtifacts.ok));
}
