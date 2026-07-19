#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildchainChannel } from "./buildchain-channel-router.mjs";

const TARGETS = [
  { pattern: /^alpha\/v(\d+)\/v\d+\.\d+$/, publicationChannel: "alpha", shellChannel: "alpha" },
  { pattern: /^release\/v(\d+)\/v\d+\.\d+$/, publicationChannel: "release", shellChannel: "stable" },
  { pattern: /^(?:publish-gate\/major|major-gate)$/, publicationChannel: "major", shellChannel: "stable" },
];

function normalized(value) {
  return String(value ?? "").trim();
}

function targetIntent(targetRef, requestedPublicationChannel = "") {
  const ref = normalized(targetRef).replace(/^refs\/heads\//, "");
  const target = TARGETS.find((entry) => entry.pattern.test(ref));
  if (!target) throw new Error(`unsupported promotion target ref: ${ref || "<empty>"}`);
  const requested = normalized(requestedPublicationChannel).toLowerCase();
  if (requested && requested !== target.publicationChannel) {
    throw new Error(`promotion channel ${requested} does not match target ref ${ref} (${target.publicationChannel})`);
  }
  return {
    targetRef: ref,
    publicationChannel: target.publicationChannel,
    shellChannel: target.shellChannel,
  };
}

export function resolvePromotionChannel({
  requestedChannel = "auto",
  requestedRef = "",
  publicationChannel = "",
  targetRef = "",
  routerRef = "",
  packageVersion = "",
} = {}) {
  const intent = targetIntent(targetRef, publicationChannel);
  const selected = resolveBuildchainChannel({
    requestedChannel,
    requestedRef,
    publishChannel: intent.publicationChannel,
    eventName: "workflow_call",
    routerRef,
    packageVersion,
  });
  const overrideUsed = selected.channel === "override";
  if (!overrideUsed && selected.channel !== intent.shellChannel) {
    throw new Error(
      `promotion target ${intent.targetRef} requires ${intent.shellChannel} shell/runtime, got ${selected.channel}`,
    );
  }
  const shellRef = intent.shellChannel === "alpha" ? `v${selected.major}-alpha` : `v${selected.major}`;
  return {
    targetRef: intent.targetRef,
    publicationChannel: intent.publicationChannel,
    channel: intent.shellChannel,
    major: selected.major,
    shellRef,
    runtimeRef: selected.buildchainRef,
    overrideUsed,
    selectionSource: selected.selectionSource,
    reason: selected.reason,
  };
}

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
    "target-ref": result.targetRef,
    "publication-channel": result.publicationChannel,
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
