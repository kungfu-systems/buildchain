#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const MANAGED_MARKER = "<!-- buildchain-dev-alpha-candidate-state";
const MAX_PREFIX_CHARACTERS = 32768;

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function resolveRendererPath(consumerRootValue, rendererValue) {
  const consumerRoot = fs.realpathSync(
    path.resolve(required(consumerRootValue, "consumerRoot")),
  );
  const renderer = required(rendererValue, "renderer");
  if (path.isAbsolute(renderer))
    throw new Error("renderer must be repository-relative");
  const candidate = path.resolve(consumerRoot, renderer);
  const candidateRelative = path.relative(consumerRoot, candidate);
  if (
    !candidateRelative ||
    candidateRelative.startsWith("..") ||
    path.isAbsolute(candidateRelative)
  )
    throw new Error("renderer must resolve inside the consumer checkout");
  const absolute = fs.realpathSync(candidate);
  const relative = path.relative(consumerRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("renderer must resolve inside the consumer checkout");
  const stat = fs.statSync(absolute);
  if (!stat.isFile())
    throw new Error("renderer must resolve to a regular file");
  return { consumerRoot, renderer: absolute };
}

function safeEnvironment(values, source = process.env) {
  const retained = [
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "RUNNER_ARCH",
    "RUNNER_OS",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
  ];
  return {
    ...Object.fromEntries(
      retained
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, source[key]]),
    ),
    BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT: values.outputPath,
    BUILDCHAIN_CHANNEL_PATROL_SELECTED_SHA: values.selectedSha,
    BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH: values.sourceBranch,
    BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH: values.targetBranch,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function checkedSpawn(command, args, options, label) {
  const result = childProcess.spawnSync(command, args, {
    ...options,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function readPrefix(outputPath) {
  const bytes = fs.readFileSync(outputPath);
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("renderer output must be valid UTF-8");
  }
  if (!value) throw new Error("renderer output must not be empty");
  if (value.length > MAX_PREFIX_CHARACTERS)
    throw new Error(
      `renderer output exceeds ${MAX_PREFIX_CHARACTERS} characters`,
    );
  if (value.includes(MANAGED_MARKER))
    throw new Error(
      "renderer output must not contain the managed candidate state marker",
    );
  return value;
}

export function appendMultilineOutput(outputFile, name, value) {
  let delimiter;
  do {
    delimiter = `buildchain_${crypto.randomUUID()}`;
  } while (value.split(/\r?\n/u).includes(delimiter));
  fs.appendFileSync(
    outputFile,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}

export function runCandidateBodyPrefixRenderer(options = {}) {
  const { consumerRoot, renderer } = resolveRendererPath(
    options.consumerRoot,
    options.renderer,
  );
  const selectedSha = required(options.selectedSha, "selectedSha");
  if (!EXACT_SHA.test(selectedSha))
    throw new Error("selectedSha must be an exact 40-character commit SHA");
  const sourceBranch = required(options.sourceBranch, "sourceBranch");
  const targetBranch = required(options.targetBranch, "targetBranch");
  const outputPath = path.resolve(required(options.outputPath, "outputPath"));
  const githubOutput = required(options.githubOutput, "githubOutput");

  const head = checkedSpawn(
    "git",
    ["rev-parse", "HEAD"],
    {
      cwd: consumerRoot,
      env: safeEnvironment({
        outputPath,
        selectedSha,
        sourceBranch,
        targetBranch,
      }),
    },
    "consumer HEAD resolution",
  ).stdout.trim();
  if (head !== selectedSha)
    throw new Error(
      `consumer checkout HEAD ${head} does not match selected SHA ${selectedSha}`,
    );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });
  const env = safeEnvironment({
    outputPath,
    selectedSha,
    sourceBranch,
    targetBranch,
  });
  checkedSpawn(
    process.execPath,
    [renderer],
    { cwd: consumerRoot, env },
    "PR body prefix renderer",
  );
  const value = readPrefix(outputPath);
  appendMultilineOutput(githubOutput, "pull-request-body-prefix", value);
  return value;
}

function main() {
  runCandidateBodyPrefixRenderer({
    consumerRoot: process.env.BUILDCHAIN_CHANNEL_PATROL_CONSUMER_ROOT,
    renderer: process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_RENDERER,
    outputPath: process.env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX_OUTPUT,
    selectedSha: process.env.BUILDCHAIN_CHANNEL_PATROL_SELECTED_SHA,
    sourceBranch: process.env.BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH,
    targetBranch: process.env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH,
    githubOutput: process.env.GITHUB_OUTPUT,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
