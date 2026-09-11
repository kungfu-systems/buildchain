import {
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  formatDiagnosticsSummaryTable,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
} from "../diagnostics.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
function readDiagnosticsArtifactInputs(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--artifact") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          "buildchain diagnostics summary --artifact requires a file path",
        );
      }
      values.push(value);
      index += 1;
      continue;
    }
    if (entry === "--output") {
      index += 1;
      continue;
    }
    if (entry === "--json") {
      continue;
    }
    values.push(entry);
  }
  return values;
}



export async function handleDiagnosticsCommand(args) {
  const [subcommand = "", ...diagnosticsArgs] = args;
  if (subcommand !== "summary") {
    throw new Error(
      "usage: buildchain diagnostics summary <diagnostics.json>...",
    );
  }
  const inputs = readDiagnosticsArtifactInputs(diagnosticsArgs);
  if (inputs.length === 0) {
    throw new Error(
      "buildchain diagnostics summary requires at least one artifact",
    );
  }
  const summary = summarizeDiagnosticsArtifacts(inputs);
  if (summary.count !== inputs.length) {
    throw new Error(
      `buildchain diagnostics summary read ${summary.count}/${inputs.length} artifacts`,
    );
  }
  const outputPath = readFlag(diagnosticsArgs, "output", "");
  writeJsonFile(outputPath, summary);
  if (readBooleanFlag(diagnosticsArgs, "json")) {
    printJson(summary);
  } else {
    process.stdout.write(
      `buildchain diagnostics summary: ${summary.count} platforms\n`,
    );
    process.stdout.write(
      `warnings: ${summary.totalWarningCount} errors: ${summary.totalErrorCount}\n`,
    );
    if (summary.diagnosticsManifestWarningCount) {
      process.stdout.write(
        `diagnostics manifest warnings: ${summary.diagnosticsManifestWarningCount}\n`,
      );
    }
    process.stdout.write(`${formatDiagnosticsSummaryTable(summary)}\n`);
    if (outputPath) {
      process.stdout.write(`wrote: ${outputPath}\n`);
    }
  }
  return;
}
