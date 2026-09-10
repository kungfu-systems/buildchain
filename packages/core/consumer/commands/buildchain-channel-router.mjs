#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBuildchainChannel } from "../channel-selection.js";
function readPackageVersion(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function appendOutputs(file, result) {
  const entries = {
    channel: result.channel,
    major: String(result.major),
    "buildchain-ref": result.buildchainRef,
    "runtime-override": String(result.runtimeOverride),
    "selection-source": result.selectionSource,
    reason: result.reason,
  };
  fs.appendFileSync(file, Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function appendSummary(file, result) {
  fs.appendFileSync(
    file,
    [
      "## Buildchain channel router",
      "",
      `- selected channel: \`${result.channel}\``,
      `- selected runtime ref: \`${result.buildchainRef}\``,
      `- selection source: \`${result.selectionSource}\``,
      `- reason: ${result.reason}`,
      "",
    ].join("\n"),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd || process.cwd());
  const result = resolveBuildchainChannel({
    requestedChannel: args.channel,
    requestedRef: args["buildchain-ref"],
    publishChannel: args["publish-channel"],
    eventName: args["event-name"],
    gitRef: args.ref,
    releasePrerelease: args["release-prerelease"],
    routerRef: args["router-ref"],
    packageVersion: readPackageVersion(cwd),
  });
  if (process.env.GITHUB_OUTPUT) appendOutputs(process.env.GITHUB_OUTPUT, result);
  if (process.env.GITHUB_STEP_SUMMARY) appendSummary(process.env.GITHUB_STEP_SUMMARY, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`buildchain-channel-router: ${error.message}`);
    process.exitCode = 1;
  });
}
