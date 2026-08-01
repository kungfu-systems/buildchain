#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  claimReleasePropagationWork,
  completeReleasePropagationWork,
  createReleasePropagationReceipt,
  createReleasePropagationStageReceipt,
  createReleasePropagationWork,
  planReleasePropagation,
  readReleasePropagationJson,
  recordReleasePropagationStage,
  repairReleasePropagationWork,
  resumeReleasePropagationWork,
  verifyReleasePropagationWork,
  writeReleasePropagationLock,
} from "../packages/core/release-propagation.js";

function usage() {
  return `Usage:
  buildchain release-propagation plan --graph <json-or-path>
                                      --upstream-release <json-or-path>
                                      [--source-node <id>] [--output <file>] [--json]
  buildchain release-propagation write-lock --plan <json-or-path>
                                            [--target <id-or-repo>] [--cwd <dir>]
                                            [--output <file>] [--json]
  buildchain release-propagation receipt --plan <json-or-path>
                                         --lock-result <json-or-path>
                                         --pr-outcome <json-or-path>
                                         [--target <id-or-repo>]
                                         [--staging-state <state>]
                                         [--production-state <state>]
                                         [--observed-at <iso-8601>]
                                         [--output <file>] [--json]
  buildchain release-propagation work create --plan <json-or-path>
                                            --expected-downstream-base-sha <git-sha>
                                            [--work-context <json-or-path>]
                                            [--target <id-or-repo>]
                                            [--output <file>] [--json]
  buildchain release-propagation work status --work <json-or-path> [--json]
  buildchain release-propagation work resume --work <json-or-path> [--json]
  buildchain release-propagation work claim --work <json-or-path>
                                           --authority <json-or-path>
                                           --expected-work-root <sha256:...>
                                           [--family-state <json-or-path>]
                                           [--output <file>] [--json]
  buildchain release-propagation work receipt --work <json-or-path>
                                             --receipt-input <json-or-path>
                                             [--output <file>] [--json]
  buildchain release-propagation work record --work <json-or-path>
                                            --receipt <json-or-path>
                                            --expected-work-root <sha256:...>
                                            [--output <file>] [--json]
  buildchain release-propagation work repair --work <json-or-path>
                                            --receipt <json-or-path>
                                            --expected-work-root <sha256:...>
                                            [--output <file>] [--json]
  buildchain release-propagation work complete --work <json-or-path>
                                              --receipt <json-or-path>
                                              --completion-decision <json-or-path>
                                              --expected-work-root <sha256:...>
                                              [--output <file>] [--json]
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeOutput(filePath, value) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFlag(args, name) {
  return readReleasePropagationJson(readFlag(args, name), {
    label: `--${name}`,
    cwd: process.cwd(),
  });
}

function readOptionalJsonFlag(args, name) {
  return args.includes(`--${name}`) ? readJsonFlag(args, name) : undefined;
}

function emitWorkResult(args, value, summary) {
  writeOutput(readFlag(args, "output", ""), value);
  if (hasFlag(args, "json")) {
    printJson(value);
  } else {
    process.stdout.write(`${summary}\n`);
  }
}

function runWorkCli(args) {
  const [mode = "", ...workArgs] = args;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (mode === "create") {
    const result = createReleasePropagationWork({
      plan: readJsonFlag(workArgs, "plan"),
      target: readFlag(workArgs, "target", ""),
      workContext: readOptionalJsonFlag(workArgs, "work-context"),
      expectedDownstreamBaseSha: readFlag(workArgs, "expected-downstream-base-sha"),
    });
    emitWorkResult(workArgs, result, `release propagation work: ${result.contentRoot}`);
    return;
  }
  if (mode === "status" || mode === "resume") {
    const work = readJsonFlag(workArgs, "work");
    const result = mode === "resume"
      ? resumeReleasePropagationWork(work)
      : verifyReleasePropagationWork(work);
    emitWorkResult(workArgs, result, `release propagation next action: ${result.nextAction.action} ${result.currentStage}`);
    return;
  }
  if (mode === "claim") {
    const result = claimReleasePropagationWork({
      work: readJsonFlag(workArgs, "work"),
      authority: readJsonFlag(workArgs, "authority"),
      familyState: readOptionalJsonFlag(workArgs, "family-state"),
      expectedWorkRoot: readFlag(workArgs, "expected-work-root"),
    });
    emitWorkResult(workArgs, result, `release propagation work claimed: ${result.contentRoot}`);
    return;
  }
  if (mode === "receipt") {
    const work = readJsonFlag(workArgs, "work");
    const input = readJsonFlag(workArgs, "receipt-input");
    const result = createReleasePropagationStageReceipt({ work, ...input });
    emitWorkResult(workArgs, result, `release propagation stage receipt: ${result.receiptRoot}`);
    return;
  }
  if (mode === "record" || mode === "repair") {
    const transition = {
      work: readJsonFlag(workArgs, "work"),
      receipt: readJsonFlag(workArgs, "receipt"),
      expectedWorkRoot: readFlag(workArgs, "expected-work-root"),
    };
    const result = mode === "record"
      ? recordReleasePropagationStage(transition)
      : repairReleasePropagationWork(transition);
    emitWorkResult(workArgs, result, `release propagation work advanced: ${result.contentRoot}`);
    return;
  }
  if (mode === "complete") {
    const result = completeReleasePropagationWork({
      work: readJsonFlag(workArgs, "work"),
      receipt: readJsonFlag(workArgs, "receipt"),
      completionDecision: readJsonFlag(workArgs, "completion-decision"),
      expectedWorkRoot: readFlag(workArgs, "expected-work-root"),
    });
    emitWorkResult(workArgs, result, `release propagation work complete: ${result.contentRoot}`);
    return;
  }
  throw new Error(`unsupported release-propagation work command: ${mode}`);
}

export function runReleasePropagationCli(argv = process.argv.slice(2)) {
  const [mode = "", ...args] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (mode === "plan") {
    const graph = readReleasePropagationJson(readFlag(args, "graph"), {
      label: "--graph",
      cwd: process.cwd(),
    });
    const upstreamRelease = readReleasePropagationJson(readFlag(args, "upstream-release"), {
      label: "--upstream-release",
      cwd: process.cwd(),
    });
    const plan = planReleasePropagation({
      graph,
      upstreamRelease,
      sourceNode: readFlag(args, "source-node", ""),
    });
    writeOutput(readFlag(args, "output", ""), plan);
    if (hasFlag(args, "json")) {
      printJson(plan);
    } else {
      process.stdout.write(`release propagation targets: ${plan.summary.targetCount}\n`);
      for (const target of plan.targets) {
        process.stdout.write(`- ${target.repository} ${target.channel} lock=${target.lockPath}\n`);
      }
    }
    return;
  }
  if (mode === "work") {
    runWorkCli(args);
    return;
  }
  if (mode === "write-lock") {
    const plan = readReleasePropagationJson(readFlag(args, "plan"), {
      label: "--plan",
      cwd: process.cwd(),
    });
    const result = writeReleasePropagationLock({
      plan,
      target: readFlag(args, "target", ""),
      cwd: readFlag(args, "cwd", process.cwd()),
      output: readFlag(args, "output", ""),
    });
    if (hasFlag(args, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`release propagation lock: ${result.path}\n`);
      process.stdout.write(`lock sha256: ${result.lockSha256}\n`);
    }
    return;
  }
  if (mode === "receipt") {
    const plan = readReleasePropagationJson(readFlag(args, "plan"), {
      label: "--plan",
      cwd: process.cwd(),
    });
    const lockResult = readReleasePropagationJson(readFlag(args, "lock-result"), {
      label: "--lock-result",
      cwd: process.cwd(),
    });
    const prOutcome = readReleasePropagationJson(readFlag(args, "pr-outcome"), {
      label: "--pr-outcome",
      cwd: process.cwd(),
    });
    const receipt = createReleasePropagationReceipt({
      plan,
      target: readFlag(args, "target", ""),
      lockResult,
      prOutcome,
      stagingState: readFlag(args, "staging-state", "pending"),
      productionState: readFlag(args, "production-state", "not-requested"),
      observedAt: readFlag(args, "observed-at", ""),
    });
    writeOutput(readFlag(args, "output", ""), receipt);
    if (hasFlag(args, "json")) {
      printJson(receipt);
    } else {
      process.stdout.write(`release propagation receipt: ${receipt.receiptSha256}\n`);
    }
    return;
  }
  throw new Error(`unsupported release-propagation command: ${mode}`);
}

if (!process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleasePropagationCli();
}
