#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePromotionChannel } from "../promotion/channel.js";
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return values;
}

function readPackageVersion(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version;
}

function writeOutputs(file, result) {
  const outputs = {
    "target-ref": result.targetRef, "publication-channel": result.publicationChannel,
    "router-ref": result.routerRef, "router-sha": result.routerSha,
    channel: result.channel,
    major: String(result.major),
    "shell-ref": result.shellRef,
    "runtime-ref": result.runtimeRef,
    "override-used": String(result.overrideUsed),
    "selection-source": result.selectionSource,
    reason: result.reason,
  };
  fs.appendFileSync(file, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(args.cwd || process.cwd());
  const result = resolvePromotionChannel({
    requestedChannel: args.channel,
    requestedRef: args["buildchain-ref"],
    publicationChannel: args["publication-channel"],
    targetRef: args["target-ref"],
    routerRef: args["router-ref"],
    routerSha: args["router-sha"],
    packageVersion: readPackageVersion(cwd),
  });
  if (process.env.GITHUB_OUTPUT) writeOutputs(process.env.GITHUB_OUTPUT, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`promotion-channel-router: ${error.message}`);
    process.exitCode = 1;
  }
}
