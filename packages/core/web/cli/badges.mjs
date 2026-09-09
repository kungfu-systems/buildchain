import fs from "node:fs";
import path from "node:path";
import {
  checkBadgeBundleBlock,
  checkReadmeBadgeBlock,
  collectBadgeBundleFacts,
  collectReadmeBadgeFacts,
  readReadme,
  updateBadgeBundleBlock,
  updateReadmeBadgeBlock,
} from "../readme-badges.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";

export async function runReadmeBadgesCli(args = []) {
  const [subcommand = "", surface = "", ...badgeArgs] = args;
  if (
    !["readme", "bundle"].includes(subcommand) ||
    (surface && surface.startsWith("--") === false)
  ) {
    throw new Error(
      "usage: buildchain badges <readme|bundle> [--cwd <dir>] [--readme <path>] [--claims <csv>] [--check] [--write] [--json]",
    );
  }
  const effectiveArgs = surface ? [surface, ...badgeArgs] : badgeArgs;
  const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
  const readmePath = readFlag(effectiveArgs, "readme", "README.md");
  const claims = readFlag(effectiveArgs, "claims", "");
  const isBundle = subcommand === "bundle";
  const facts = isBundle
    ? await collectBadgeBundleFacts({ cwd, claims })
    : await collectReadmeBadgeFacts({ cwd });
  const checkBlock = isBundle ? checkBadgeBundleBlock : checkReadmeBadgeBlock;
  const updateBlock = isBundle
    ? updateBadgeBundleBlock
    : updateReadmeBadgeBlock;
  const commandLabel = `buildchain badges ${subcommand}`;
  if (
    readBooleanFlag(effectiveArgs, "json") &&
    !readBooleanFlag(effectiveArgs, "check") &&
    !readBooleanFlag(effectiveArgs, "write")
  ) {
    printJson(facts);
    return;
  }
  const readmeText = readReadme({ cwd, readmePath });
  if (!readmeText) {
    throw new Error(`README not found: ${path.join(cwd, readmePath)}`);
  }
  const check = checkBlock({ readmeText, facts });
  if (readBooleanFlag(effectiveArgs, "write")) {
    const next = updateBlock({ readmeText, facts });
    fs.writeFileSync(path.join(cwd, readmePath), next);
    const result = {
      schemaVersion: 1,
      contract: isBundle
        ? "kungfu-buildchain-badge-bundle-write"
        : "kungfu-buildchain-readme-badge-write",
      ok: true,
      changed: next !== readmeText,
      readmePath,
      facts,
    };
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(
        `${commandLabel}: ${result.changed ? "updated" : "current"}\n`,
      );
    }
    return;
  }
  if (readBooleanFlag(effectiveArgs, "check")) {
    if (readBooleanFlag(effectiveArgs, "json")) {
      printJson(check);
    } else {
      process.stdout.write(`${commandLabel}: ${check.ok ? "ok" : "failed"}\n`);
      if (!check.ok) {
        process.stdout.write(`${check.message}\n`);
      }
    }
    if (!check.ok) {
      process.exitCode = 1;
    }
    return;
  }
  printJson(facts);
}

export async function handleBadgesCommand(args) {
  await runReadmeBadgesCli(args);
  return;
}
