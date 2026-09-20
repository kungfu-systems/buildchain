#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PAPER_MIGRATION_CONTRACT,
  PAPER_PREFLIGHT_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
  PAPER_STATUS_CONTRACT,
} from "../operations/identity.js";
import { collectPaperPreflight } from "../paper.js";
import { resolvePaperBuildchainSha } from "../paper-agent-entry.js";
import { collectPaperStatus } from "../operations/status.js";

import {
  printPaperWorkFleetSummary,
  runPaperWorkFleetCli,
} from "./paper-work-fleet-cli.mjs";
import { runPaperAgentCli } from "./paper-agent-cli.mjs";

function usage() {
  return `Usage:
  buildchain paper scaffold --repository <owner/repo> [--package <name>]
                            [--cwd <dir>] [--name <name>] [--title <title>]
                            [--version <semver>] [--site-base-url <url>]
                            [--write] [--json]
  buildchain paper migrate [--cwd <dir>] [--write] [--json]
  buildchain paper work start <topic> [--cwd <dir>] [--branch <branch>]
                              [--execute] [--json]
  buildchain paper work submit [--cwd <dir>] [--title <title>] [--body <body>]
                               [--execute] [--json]
  buildchain paper fleet audit [--root <dir>] [--offline] [--json]
  buildchain paper fleet update [--root <dir>] [--write] [--json]
  buildchain paper agent verify [--cwd <dir>] [--offline] [--json]
  buildchain paper preflight [--cwd <dir>] [--offline] [--json]
  buildchain paper status [--cwd <dir>] [--json]

Safety:
  scaffold is a no-overwrite dry-run unless --write is present. migrate only
  converts Paper product configuration to schema 2 and retires verified legacy
  controls while preserving source files, runtime locks and historical receipts. work start/submit refuse dirty, stale, forked, ambiguous,
  protected, or non-fast-forward sources. fleet update requires isolated work
  branches and is a dry-run unless --write is present.
  Product build and verification commands belong in TOML. A legal channel PR
  requests publication; the generated recovery caller accepts an exact attempt.
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function humanSummary(result) {
  if (result.contract === PAPER_SCAFFOLD_CONTRACT) {
    process.stdout.write(
      `paper scaffold: ${result.ok ? "ok" : "conflict"} (${result.dryRun ? "dry-run" : "write"})\n`,
    );
    process.stdout.write(
      `create=${result.summary.create} unchanged=${result.summary.unchanged} conflict=${result.summary.conflict}\n`,
    );
    for (const entry of result.changes) {
      process.stdout.write(`- ${entry.action}: ${entry.path}\n`);
    }
    return;
  }
  if (result.contract === PAPER_MIGRATION_CONTRACT) {
    process.stdout.write(
      `paper migrate: ${result.ok ? "ok" : "blocked"} (${result.dryRun ? "dry-run" : "write"})\n`,
    );
    process.stdout.write(
      `create=${result.summary.create} update=${result.summary.update} remove=${result.summary.remove} unchanged=${result.summary.unchanged} conflict=${result.summary.conflict}\n`,
    );
    for (const entry of result.changes) {
      process.stdout.write(`- ${entry.action}: ${entry.path}\n`);
    }
    return;
  }
  if (result.contract === PAPER_PREFLIGHT_CONTRACT) {
    process.stdout.write(
      `paper preflight: ${result.ok ? "ready" : "blocked"}\n`,
    );
    for (const check of result.checks) {
      process.stdout.write(
        `- ${check.status}: ${check.id}: ${check.message}\n`,
      );
    }
    return;
  }
  if (result.contract === PAPER_STATUS_CONTRACT) {
    process.stdout.write(`paper status: ${result.highestEvidenceState}\n`);
    for (const entry of result.states) {
      process.stdout.write(`- ${entry.status}: ${entry.id}: ${entry.reason}\n`);
    }
    return;
  }

  printPaperWorkFleetSummary(result, printJson);
}

function printResult(result, json) {
  if (json) printJson(result);
  else humanSummary(result);
}

export async function runPaperCli(
  args = [],
  {
    buildchainRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    ),
    buildchainVersion = "",
    buildchainRef = "v4-alpha",
    buildchainSha = "",
  } = {},
) {
  const [command = "", maybeSubcommand = "", ...rest] = args;
  const json = hasFlag(args, "json");
  try {
    if (!command || ["help", "--help", "-h"].includes(command)) {
      process.stdout.write(usage());
      return;
    }
    if (
      ![
        "scaffold",
        "migrate",
        "work",
        "fleet",
        "agent",
        "preflight",
        "status",
      ].includes(command)
    )
      throw new Error(
        "Unknown Paper command. Use product commands from TOML, a channel PR for publication, or the generated attempt recovery entry.",
      );
    const effectiveArgs = maybeSubcommand.startsWith("--")
      ? [maybeSubcommand, ...rest]
      : rest;
    const cwd = path.resolve(readFlag(effectiveArgs, "cwd", process.cwd()));
    if (!["scaffold", "preflight", "status"].includes(command))
      buildchainSha = resolvePaperBuildchainSha(buildchainRoot, buildchainSha);
    const workFleet = runPaperWorkFleetCli({
      command,
      subcommand: maybeSubcommand,
      args: effectiveArgs,
      cwd,
      buildchainRoot,
      buildchainVersion,
      buildchainRef,
      buildchainSha,
    });
    // prettier-ignore
    const paperAgent = runPaperAgentCli({ command, subcommand: maybeSubcommand, args: effectiveArgs, cwd, buildchainRoot, buildchainVersion, buildchainRef, buildchainSha });
    let result;
    if (paperAgent.handled) {
      result = paperAgent.result;
    } else if (workFleet.handled) {
      result = workFleet.result;
    } else if (command === "preflight") {
      result = collectPaperPreflight({
        cwd,
        buildchainRoot,
        buildchainVersion,
        buildchainRef: readFlag(effectiveArgs, "buildchain-ref", buildchainRef),
        buildchainSha,
        registry: readFlag(
          effectiveArgs,
          "registry",
          "https://registry.npmjs.org/",
        ),
        offline: hasFlag(effectiveArgs, "offline"),
        agentEntryMode: hasFlag(effectiveArgs, "ci")
          ? "ci"
          : hasFlag(effectiveArgs, "agent-entry")
            ? "local"
            : "contract",
      });
    } else {
      throw new Error(
        "usage: buildchain paper <scaffold|migrate|work start|work submit|fleet audit|fleet update|agent verify|preflight|status> ...",
      );
    }
    printResult(result, json);
    if (result.ok === false) {
      process.exitCode = 1;
    }
    return result;
  } catch (error) {
    if (!json) throw error;
    const failure = {
      schemaVersion: 1,
      contract: "kungfu-buildchain-paper-error",
      ok: false,
      error: {
        code: error.code || "paper-command-failed",
        message: error.message,
      },
      nextActions: [],
    };
    printJson(failure);
    process.exitCode = 1;
    return failure;
  }
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../package.json",
      ),
      "utf8",
    ),
  );
  runPaperCli(process.argv.slice(2), {
    buildchainRoot: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    ),
    buildchainVersion: packageJson.version,
  }).catch((error) => {
    console.error(`paper: ${error.message}`);
    process.exitCode = 1;
  });
}
