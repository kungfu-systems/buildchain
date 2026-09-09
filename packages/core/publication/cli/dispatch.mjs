import { npmPublishDryRun } from "../commands/npm-publish-dry-run.mjs";
import { runPublicationArtifactCli } from "../commands/publication-artifact.mjs";
import { runPublicationPackageCli } from "../commands/publication-package.mjs";
import { runPublicationReproducibilityCli } from "../commands/publication-reproducibility.mjs";
import {
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  formatDiagnosticsSummaryTable,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
} from "../../observability/diagnostics.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { runScript } from "../../workflow/cli/process.mjs";

export async function handleNpmCommand(args) {
  const [subcommand = "", ...npmArgs] = args;
  if (subcommand !== "dry-run") {
    throw new Error("usage: buildchain npm dry-run");
  }
  const result = npmPublishDryRun({
    cwd: readFlag(npmArgs, "cwd", process.cwd()),
    expectedTag: readFlag(npmArgs, "expected-tag", ""),
    registry: readFlag(npmArgs, "registry", "https://registry.npmjs.org/"),
    distTag: readFlag(npmArgs, "dist-tag", ""),
    skipNpmPublishDryRun: readBooleanFlag(npmArgs, "skip-npm-publish-dry-run"),
  });
  if (readBooleanFlag(npmArgs, "json")) {
    printJson(result);
  } else {
    process.stdout.write(
      `npm publish dry-run ok: ${result.package.name}@${result.package.version} -> ${result.distTag}\n`,
    );
    process.stdout.write(`pack entries: ${result.pack.entryCount}\n`);
  }
  return;
}

export async function handlePublicationArtifactCommand(args) {
  if (args[0] === "npm-package" || args[0] === "package") {
    runPublicationPackageCli(args.slice(1));
    return;
  }
  if (args[0] === "reproducibility" || args[0] === "reproducible") {
    runPublicationReproducibilityCli(args.slice(1));
    return;
  }
  runPublicationArtifactCli(args);
  return;
}

export async function handlePublishSourceCommand(args) {
  const [mode = "lock", ...publishArgs] = args;
  if (mode === "lock" || mode === "manifest") {
    runScript("packages/core/release/commands/resolve-publish-source.mjs", [
      "--mode",
      mode,
      ...publishArgs,
    ]);
    return;
  }
  if (mode === "verify-lock") {
    runScript(
      "packages/core/release/commands/verify-publish-source-lock.mjs",
      publishArgs,
    );
    return;
  }
  if (mode === "verify-channel-ref") {
    runScript(
      "packages/core/release/commands/verify-publish-channel-ref.mjs",
      publishArgs,
    );
    return;
  }
  if (mode === "validate-anchored-release") {
    const report = validateAnchoredPackageRelease({
      cwd: readFlag(publishArgs, "cwd", process.cwd()),
      requirePublishGateSourceLock: true,
    });
    if (readBooleanFlag(publishArgs, "json")) {
      printJson(report);
    } else {
      process.stdout.write(
        `anchored release source lock: ${report.ok ? "ok" : "failed"}\n`,
      );
      for (const entry of report.checks) {
        process.stdout.write(
          `- ${entry.status}: ${entry.id}: ${entry.message}\n`,
        );
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(`unsupported publish-source command: ${mode}`);
}
