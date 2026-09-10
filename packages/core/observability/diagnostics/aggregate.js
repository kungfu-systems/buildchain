import fs from "node:fs";
import path from "node:path";
import { findJsonFiles } from "../../build/artifact/files.js";
import { summarizeDiagnosticsArtifacts } from "../diagnostics.js";
export function aggregateDiagnosticsSummary({
  inputRoot,
  outputPath,
  expectedPlatformCount,
}) {
  const diagnosticsFiles = findJsonFiles(inputRoot)
    .filter((file) => path.basename(file) === "diagnostics.json")
    .sort();
  if (
    expectedPlatformCount > 0 &&
    diagnosticsFiles.length !== expectedPlatformCount
  ) {
    throw new Error(
      `expected ${expectedPlatformCount} platform diagnostics artifacts, found ${diagnosticsFiles.length} under ${inputRoot}`,
    );
  }
  const summary = summarizeDiagnosticsArtifacts(diagnosticsFiles);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
