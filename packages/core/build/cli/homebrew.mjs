import path from "node:path";
import {
  checkHomebrewTap,
  collectHomebrewTapFacts,
  renderHomebrewFormula,
  updateHomebrewTap,
} from "../homebrew.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export async function runHomebrewCli(args = []) {
  const [subcommand = "", ...homebrewArgs] = args;
  const cwd = path.resolve(readFlag(homebrewArgs, "cwd", process.cwd()));
  const packageName = readFlag(homebrewArgs, "package", "buildchain");
  const releasePassport = readFlag(homebrewArgs, "release-passport", "");
  const manifestPath = readFlag(homebrewArgs, "manifest", "tap-manifest.json");
  const formulaPath = readFlag(homebrewArgs, "formula", "");
  const json = readBooleanFlag(homebrewArgs, "json");
  if (subcommand === "update-formula") {
    if (!releasePassport) {
      throw new Error(
        "buildchain homebrew update-formula requires --release-passport <file-or-url>",
      );
    }
    if (readBooleanFlag(homebrewArgs, "write")) {
      const result = await updateHomebrewTap({
        cwd,
        packageName,
        releasePassport,
        manifestPath,
        formulaPath,
        write: true,
      });
      if (json) {
        printJson(result);
      } else {
        process.stdout.write(
          `buildchain homebrew update-formula: wrote ${result.written.join(", ")}\n`,
        );
      }
      return;
    }
    const facts = await collectHomebrewTapFacts({
      cwd,
      packageName,
      releasePassport,
      manifestPath,
      formulaPath,
    });
    if (json) {
      printJson({
        schemaVersion: 1,
        contract: "kungfu-buildchain-homebrew-formula-render",
        facts,
        formula: renderHomebrewFormula(facts),
        manifest: facts.manifestProjection,
      });
    } else {
      process.stdout.write(renderHomebrewFormula(facts));
    }
    return;
  }
  if (subcommand === "check") {
    const report = await checkHomebrewTap({
      cwd,
      packageName,
      releasePassport,
      manifestPath,
      formulaPath,
    });
    if (json) {
      printJson(report);
    } else {
      process.stdout.write(
        `buildchain homebrew check: ${report.ok ? "ok" : "failed"}\n`,
      );
      for (const check of report.checks) {
        process.stdout.write(
          `- ${check.status}: ${check.id}: ${check.message}\n`,
        );
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("usage: buildchain homebrew <update-formula|check> ...");
}

export async function handleHomebrewCommand(args) {
  await runHomebrewCli(args);
  return;
}
