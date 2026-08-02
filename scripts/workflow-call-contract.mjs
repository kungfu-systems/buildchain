#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { evaluateWorkflowCallContract } from "../packages/core/workflow-call-contract.js";

function usage() {
  return `usage: node scripts/workflow-call-contract.mjs check \\
  --caller-workflow <path> --job <id> --caller-repository <owner/repo> \\
  --callee-root <checkout> --callee-workflow <path> --callee-repository <owner/repo> \\
  --trusted-event <event[:type]> [--trusted-event ...] \\
  [--expected-contract-root sha256:...] [--allow-dirty] [--output <path>]`;
}

function parseArgs(argv) {
  const options = { trustedEvents: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (!arg.startsWith("--") || !argv[index + 1])
      throw new Error(`invalid argument: ${arg}`);
    const value = argv[index + 1];
    index += 1;
    if (arg === "--trusted-event") options.trustedEvents.push(value);
    else
      options[
        arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
      ] = value;
  }
  return options;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function required(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw new Error(`missing required options: ${missing.join(", ")}`);
}

export function checkWorkflowCall(options) {
  const callerRoot = path.resolve(options.callerRoot || process.cwd());
  const calleeRoot = path.resolve(options.calleeRoot);
  const callerStatus = git(
    callerRoot,
    "status",
    "--porcelain",
    "--untracked-files=no",
  );
  if (callerStatus && !options.allowDirty) {
    throw new Error(
      "caller checkout is dirty; use --allow-dirty only for local diagnostic validation",
    );
  }
  const calleeStatus = git(
    calleeRoot,
    "status",
    "--porcelain",
    "--untracked-files=no",
  );
  if (calleeStatus) {
    throw new Error("callee checkout is dirty; exact pinned-ref bytes are required");
  }
  const callerSha = git(callerRoot, "rev-parse", "HEAD");
  const callerTree = git(callerRoot, "rev-parse", "HEAD^{tree}");
  const calleeSha = git(calleeRoot, "rev-parse", "HEAD");
  const report = evaluateWorkflowCallContract({
    callerText: fs.readFileSync(
      path.join(callerRoot, options.callerWorkflow),
      "utf8",
    ),
    calleeText: fs.readFileSync(
      path.join(calleeRoot, options.calleeWorkflow),
      "utf8",
    ),
    callerRepository: options.callerRepository,
    callerWorkflowPath: options.callerWorkflow,
    callerSha,
    callerTree,
    callerSourceState: callerStatus ? "diagnostic-dirty" : "clean",
    calleeRepository: options.calleeRepository,
    calleeWorkflowPath: options.calleeWorkflow,
    calleeSha,
    jobId: options.job,
    trustedEventClasses: options.trustedEvents,
    expectedContractRoot: options.expectedContractRoot || "",
  });
  if (options.output) {
    const output = path.resolve(callerRoot, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  if (command !== "check") throw new Error(usage());
  const options = parseArgs(argv);
  required(options, [
    "callerWorkflow",
    "job",
    "callerRepository",
    "calleeRoot",
    "calleeWorkflow",
    "calleeRepository",
  ]);
  if (!options.trustedEvents.length)
    throw new Error("at least one --trusted-event is required");
  const report = checkWorkflowCall(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`workflow call contract: ${error.message}`);
    process.exitCode = 1;
  }
}
