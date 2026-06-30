import fs from "node:fs";
import os from "node:os";
import { runLifecycle } from "../../scripts/run-lifecycle-core.mjs";

function inputName(name) {
  return `INPUT_${String(name).replace(/ /g, "_").toUpperCase()}`;
}

function getInput(name) {
  return (process.env[inputName(name)] || "").trim();
}

function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    fs.appendFileSync(output, `${name}=${value}${os.EOL}`);
    return;
  }
  console.log(`::set-output name=${name}::${value}`);
}

function setFailed(message) {
  process.exitCode = 1;
  console.error(`::error::${String(message).replace(/\r?\n/g, "%0A")}`);
}

async function main() {
  const manifestPath = getInput("manifest-path") || ".buildchain/artifacts/manifest.json";
  const summaryPath = getInput("summary-path") || ".buildchain/artifacts/summary.json";
  const manifest = runLifecycle({
    cwd: getInput("cwd") || ".",
    stageName: getInput("stage") || "build",
    command: getInput("command") || "",
    required: getInput("required") === "true",
    manifestPath,
    summaryPath,
    artifactName: getInput("artifact-name") || "buildchain-artifact",
    platformId: getInput("platform-id") || process.env.RUNNER_OS || process.platform,
    platformName: getInput("platform-name") || getInput("platform-id") || process.env.RUNNER_OS || process.platform,
    artifactPaths: String(getInput("artifact-paths") || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    expectedArtifactsJson: getInput("expected-artifacts-json") || "",
    workspace: process.cwd(),
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

main().catch((error) => setFailed(error.message));
