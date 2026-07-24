#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findJsonFiles, writeGitHubOutputs } from "./build-contract-core.mjs";
import {
  formatDiagnosticsSummaryTable,
  summarizeDiagnosticsArtifacts,
} from "../packages/core/diagnostics.js";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function aggregateDiagnosticsSummaryCli() {
  const inputRoot = path.resolve(readEnv("BUILDCHAIN_DIAGNOSTICS_INPUT", ".buildchain/downloaded-diagnostics"));
  const outputPath = path.resolve(readEnv("BUILDCHAIN_DIAGNOSTICS_OUTPUT", ".buildchain/artifacts/diagnostics-summary.json"));
  const expectedPlatformCount = Number(readEnv("BUILDCHAIN_PLATFORM_COUNT", "0"));
  const diagnosticsFiles = findJsonFiles(inputRoot)
    .filter((file) => path.basename(file) === "diagnostics.json")
    .sort();
  if (expectedPlatformCount > 0 && diagnosticsFiles.length !== expectedPlatformCount) {
    throw new Error(
      `expected ${expectedPlatformCount} platform diagnostics artifacts, found ${diagnosticsFiles.length} under ${inputRoot}`,
    );
  }
  const summary = summarizeDiagnosticsArtifacts(diagnosticsFiles);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${formatDiagnosticsSummaryTable(summary)}\n`);
  writeGitHubOutputs({
    "diagnostics-summary-path": path.relative(process.cwd(), outputPath).split(path.sep).join("/"),
    "diagnostics-platform-count": String(summary.count),
    "diagnostics-summary-json": JSON.stringify({
      contract: summary.contract,
      count: summary.count,
      totalWarningCount: summary.totalWarningCount,
      totalErrorCount: summary.totalErrorCount,
      diagnosticsManifestWarningCount: summary.diagnosticsManifestWarningCount,
      diagnosticsContractWarningCount: summary.diagnosticsContractWarningCount,
      slowestPlatforms: summary.slowestPlatforms,
    }),
  });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    aggregateDiagnosticsSummaryCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}
