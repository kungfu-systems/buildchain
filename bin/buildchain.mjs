#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import { npmPublishDryRun } from "../scripts/npm-publish-dry-run.mjs";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";
import { detectPackageManager } from "../packages/core/package-manager.js";
import {
  createBuildchainLogger,
  defaultBuildchainLogPath,
  summarizeBuildchainLogEvents,
  verifyBuildchainLogEvents,
} from "../packages/core/logging.js";
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../packages/core/release-line-dry-run.js";
import {
  collectGitHubReleasePassport,
  explainReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const embeddedPackageVersion = process.env.BUILDCHAIN_EMBEDDED_PACKAGE_VERSION || "";

function usage() {
  return `Usage:
  buildchain --help
  buildchain version
  buildchain init [--cwd <dir>] [--type package|native|web-surface|anchored-package] [--force]
                  [--package-manager pnpm|npm|yarn] [--runner-preset <preset>]
                  [--artifact-name <template>]
  buildchain validate [--cwd <dir>] [--require-version-state]
                      [--require-lifecycle-stages <comma-list>]
  buildchain lifecycle run <stage> [--cwd <dir>] [--required]
                             [--artifact-name <name>] [--artifact-path <path>]...
  buildchain npm dry-run [--cwd <dir>] [--expected-tag <tag>] [--registry <url>]
                         [--dist-tag <tag>] [--skip-npm-publish-dry-run] [--json]
  buildchain release --dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                 [--tags <comma-list>] [--json]
  buildchain release explain --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                     [--tags <comma-list>] [--json]
  buildchain release dry-run --target-ref <ref> [--sha <sha>] [--source-ref <ref>]
                                      [--tags <comma-list>] [--json]
  buildchain release <inspect|recover|finalize|abort> ...
  buildchain transaction inspect ...
  buildchain collect github-release --tag <tag> [--repository <owner/repo>]
                                    [--assets-dir <dir>] [--assets-json <json-or-path>]
                                    [--release-json <json-or-path>] [--output-dir <dir>] [--json]
  buildchain verify release-passport <file-or-url> [--json]
  buildchain verify observability-log <jsonl> [--min-events <n>]
                                             [--require-phase <csv>]
                                             [--require-component <csv>]
                                             [--require-event <csv>] [--allow-errors] [--json]
  buildchain explain release --passport <file-or-url> [--for human|agent] [--json]
  buildchain inspect release --passport <file-or-url> [--json]
  buildchain doctor [--cwd <dir>] [--json]
  buildchain log <info|warn|error> --event <name> [--phase <phase>]
                 [--component <name>] [--source <name>] [--attribute key=value]...
                 [--path <jsonl>] [--json]
  buildchain log summary [--path <jsonl>] [--json]
  buildchain mark --event <name> [--phase <phase>] [--component <name>]
                  [--attribute key=value]... [--path <jsonl>] [--json]
  buildchain span --event <name> [--phase <phase>] [--component <name>]
                  [--path <jsonl>] -- <command> [args...]
  buildchain web-surface ...
  buildchain publish-source <lock|manifest|verify-lock> ...
  buildchain build-contract ...

Examples:
  buildchain init --type package --package-manager pnpm
  buildchain validate --require-version-state --require-lifecycle-stages build,verify
  buildchain lifecycle run build --artifact-path dist --artifact-name "{repo}-{version}-{platform}"
  buildchain npm dry-run --json
  buildchain release --dry-run --target-ref alpha/v2/v2.0
  buildchain span --event native.build -- cmake --build build
  buildchain collect github-release --tag v2.2.0 --assets-dir dist --output-dir .buildchain/release-passport
  buildchain verify release-passport .buildchain/release-passport/buildchain.release.json
  buildchain verify observability-log .buildchain/logs/events.jsonl --min-events 4 --require-phase build
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function readAttributes(args) {
  const attributes = {};
  for (const value of readRepeatedFlag(args, "attribute")) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      attributes[value] = true;
    } else {
      attributes[value.slice(0, separator)] = value.slice(separator + 1);
    }
  }
  return attributes;
}

function defaultCliLogPath(args) {
  return readFlag(args, "path", process.env.BUILDCHAIN_LOG_PATH || defaultBuildchainLogPath({ cwd: process.cwd() }));
}

function cliLogger(args, defaults = {}) {
  return createBuildchainLogger({
    cwd: process.cwd(),
    path: defaultCliLogPath(args),
    console: !readBooleanFlag(args, "quiet"),
    source: readFlag(args, "source", defaults.source || "user"),
    component: readFlag(args, "component", defaults.component || "cli"),
    phase: readFlag(args, "phase", defaults.phase || ""),
  });
}

function checkStatus(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

function runDoctor({ cwd = process.cwd() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const checks = [];
  checks.push(checkStatus(fs.existsSync(resolvedCwd), "cwd.exists", "working directory exists", { cwd: resolvedCwd }));
  try {
    const validation = validateBuildchainConfig(resolvedCwd);
    checks.push(checkStatus(true, "config.valid", "buildchain.toml is valid", {
      projectType: validation.project?.type || "",
      lifecycleStages: validation.lifecycleStages.map((stage) => stage.name),
    }));
  } catch (error) {
    checks.push(checkStatus(false, "config.valid", error.message));
  }
  try {
    const manager = detectPackageManager(resolvedCwd);
    checks.push(checkStatus(true, "package-manager.detected", `package manager: ${manager.name}`, manager));
  } catch (error) {
    checks.push(checkStatus(false, "package-manager.detected", error.message));
  }
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: resolvedCwd,
    encoding: "utf8",
  });
  checks.push(checkStatus(git.status === 0 && git.stdout.trim() === "true", "git.repository", "directory is a git repository"));
  const workflowPath = path.join(resolvedCwd, ".github", "workflows", "build.yml");
  checks.push(checkStatus(fs.existsSync(workflowPath), "workflow.build", "reusable workflow caller exists", {
    path: ".github/workflows/build.yml",
  }));
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-doctor",
    cwd: resolvedCwd,
    ok: checks.every((check) => check.status === "pass"),
    checks,
    docsUrl: "https://buildchain.libkungfu.dev/docs/cli",
  };
}

function runScript(scriptName, args) {
  const scriptPath = path.join(root, "scripts", scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function packageVersion() {
  if (embeddedPackageVersion) {
    return embeddedPackageVersion;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return packageJson.version;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (command === "init") {
    const result = initBuildchainRepo({
      cwd: readFlag(args, "cwd", process.cwd()),
      type: readFlag(args, "type", "package"),
      force: readBooleanFlag(args, "force"),
      packageManager: readFlag(args, "package-manager", ""),
      runnerPreset: readFlag(args, "runner-preset", "github-hosted"),
      artifactName: readFlag(args, "artifact-name", "{repo}-{version}-{platform}"),
    });
    printJson(result);
    return;
  }

  if (command === "validate") {
    const lifecycleStages = readFlag(args, "require-lifecycle-stages", "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    printJson(validateBuildchainConfig(readFlag(args, "cwd", process.cwd()), {
      requireVersionState: readBooleanFlag(args, "require-version-state"),
      requireLifecycleStages: lifecycleStages,
    }));
    return;
  }

  if (command === "doctor") {
    const result = runDoctor({ cwd: readFlag(args, "cwd", process.cwd()) });
    if (readBooleanFlag(args, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`buildchain doctor: ${result.ok ? "ok" : "failed"}\n`);
      for (const check of result.checks) {
        process.stdout.write(`- ${check.status}: ${check.id}: ${check.message}\n`);
      }
    }
    return;
  }

  if (command === "log") {
    const [levelOrSubcommand = "info", ...logArgs] = args;
    if (levelOrSubcommand === "summary") {
      const logPath = defaultCliLogPath(logArgs);
      const summary = summarizeBuildchainLogEvents({ path: logPath });
      if (readBooleanFlag(logArgs, "json")) {
        printJson(summary);
      } else {
        process.stdout.write(`buildchain log summary: ${summary.eventCount} events\n`);
        process.stdout.write(`sources: ${Object.keys(summary.sources).join(", ") || "none"}\n`);
        process.stdout.write(`phases: ${Object.keys(summary.phases).join(", ") || "none"}\n`);
      }
      return;
    }
    if (!["info", "warn", "error"].includes(levelOrSubcommand)) {
      throw new Error("usage: buildchain log <info|warn|error> --event <name>");
    }
    const eventName = readFlag(logArgs, "event", "");
    if (!eventName) {
      throw new Error("buildchain log requires --event <name>");
    }
    const logger = cliLogger(logArgs);
    const event = logger.emit(levelOrSubcommand, eventName, {
      message: readFlag(logArgs, "message", ""),
      attributes: readAttributes(logArgs),
    });
    if (readBooleanFlag(logArgs, "json")) {
      printJson(event);
    }
    return;
  }

  if (command === "mark") {
    const eventName = readFlag(args, "event", "");
    if (!eventName) {
      throw new Error("buildchain mark requires --event <name>");
    }
    const logger = cliLogger(args);
    const event = logger.mark(eventName, {
      message: readFlag(args, "message", ""),
      attributes: readAttributes(args),
    });
    if (readBooleanFlag(args, "json")) {
      printJson(event);
    }
    return;
  }

  if (command === "span") {
    const separator = args.indexOf("--");
    const spanArgs = separator === -1 ? args : args.slice(0, separator);
    const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
    const eventName = readFlag(spanArgs, "event", "");
    if (!eventName || commandArgs.length === 0) {
      throw new Error("usage: buildchain span --event <name> -- <command> [args...]");
    }
    const logger = cliLogger(spanArgs);
    const spanId = crypto.randomUUID();
    const startedAt = Date.now();
    logger.info(`${eventName}.start`, {
      spanId,
      message: readFlag(spanArgs, "message", ""),
      attributes: readAttributes(spanArgs),
    });
    const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    const durationMs = Date.now() - startedAt;
    if (result.error || result.status !== 0) {
      logger.error(`${eventName}.error`, {
        spanId,
        durationMs,
        message: result.error?.message || `command exited with ${result.status ?? "signal"}`,
        attributes: {
          ...readAttributes(spanArgs),
          status: result.status ?? "",
          signal: result.signal || "",
        },
      });
      process.exitCode = result.status ?? 1;
      return;
    }
    logger.info(`${eventName}.end`, {
      spanId,
      durationMs,
      attributes: readAttributes(spanArgs),
    });
    return;
  }

  if (command === "lifecycle") {
    const [subcommand, stageName = "", ...lifecycleArgs] = args;
    if (subcommand !== "run" || !stageName) {
      throw new Error("usage: buildchain lifecycle run <stage>");
    }
    const artifactPaths = readRepeatedFlag(lifecycleArgs, "artifact-path");
    const manifest = runLifecycle({
      cwd: readFlag(lifecycleArgs, "cwd", process.cwd()),
      stageName,
      required: readBooleanFlag(lifecycleArgs, "required"),
      artifactName: readFlag(lifecycleArgs, "artifact-name", "buildchain-artifact"),
      artifactPaths,
      expectedArtifactsJson: readFlag(lifecycleArgs, "expected-artifacts-json", ""),
      logPath: readFlag(lifecycleArgs, "log-path", process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl"),
      workspace: process.cwd(),
    });
    printJson(manifest);
    return;
  }

  if (command === "npm") {
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
      process.stdout.write(`npm publish dry-run ok: ${result.package.name}@${result.package.version} -> ${result.distTag}\n`);
      process.stdout.write(`pack entries: ${result.pack.entryCount}\n`);
    }
    return;
  }

  if (command === "release") {
    const explainMode = args[0] === "dry-run" || args[0] === "explain";
    const releaseArgs = explainMode ? args.slice(1) : args;
    if (explainMode || readBooleanFlag(args, "dry-run")) {
      const plan = explainReleaseLineDryRun({
        cwd: readFlag(releaseArgs, "cwd", process.cwd()),
        targetRef: readFlag(releaseArgs, "target-ref", ""),
        sourceRef: readFlag(releaseArgs, "source-ref", ""),
        sha: readFlag(releaseArgs, "sha", ""),
        tags: readFlag(releaseArgs, "tags", ""),
        publishTransaction: readBooleanFlag(releaseArgs, "publish-transaction"),
        publishCommand: readFlag(releaseArgs, "publish-command", ""),
      });
      if (readBooleanFlag(releaseArgs, "json")) {
        printJson(plan);
      } else {
        process.stdout.write(formatReleaseLineDryRun(plan));
      }
      return;
    }
    runScript("release-transaction.mjs", args);
    return;
  }

  if (command === "transaction") {
    const [subcommand = "inspect", ...transactionArgs] = args;
    if (subcommand !== "inspect") {
      throw new Error("usage: buildchain transaction inspect ...");
    }
    runScript("release-transaction.mjs", ["inspect", ...transactionArgs]);
    return;
  }

  if (command === "collect") {
    const [subcommand = "", ...collectArgs] = args;
    if (subcommand !== "github-release") {
      throw new Error("usage: buildchain collect github-release --tag <tag>");
    }
    const workflow = {
      name: process.env.GITHUB_WORKFLOW || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
      url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "",
      runnerKind: process.env.BUILDCHAIN_RUNNER_KIND || "github-hosted",
      runnerOs: process.env.RUNNER_OS || process.platform,
      runnerArch: process.env.RUNNER_ARCH || process.arch,
      runnerImage: process.env.ImageOS || "",
    };
    const result = collectGitHubReleasePassport({
      cwd: readFlag(collectArgs, "cwd", process.cwd()),
      tag: readFlag(collectArgs, "tag", ""),
      repository: readFlag(collectArgs, "repository", process.env.GITHUB_REPOSITORY || ""),
      sourceSha: readFlag(collectArgs, "source-sha", process.env.GITHUB_SHA || ""),
      line: readFlag(collectArgs, "line", ""),
      outputDir: readFlag(collectArgs, "output-dir", ".buildchain/release-passport"),
      assetsDir: readFlag(collectArgs, "assets-dir", ""),
      assetsJson: readFlag(collectArgs, "assets-json", ""),
      releaseJson: readFlag(collectArgs, "release-json", ""),
      packageName: readFlag(collectArgs, "package-name", "@kungfu-tech/buildchain"),
      packageVersion: readFlag(collectArgs, "package-version", packageVersion()),
      workflow,
    });
    if (readBooleanFlag(collectArgs, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`release passport collected: ${path.relative(process.cwd(), result.outputDir)}\n`);
      process.stdout.write(`artifacts: ${result.artifactEvidence.artifacts.length}\n`);
    }
    return;
  }

  if (command === "verify") {
    const [subcommand = "", location = "", ...verifyArgs] = args;
    if (subcommand === "observability-log") {
      if (!location) {
        throw new Error("usage: buildchain verify observability-log <jsonl>");
      }
      const report = verifyBuildchainLogEvents({
        path: location,
        minEvents: Number(readFlag(verifyArgs, "min-events", "1")),
        allowErrors: readBooleanFlag(verifyArgs, "allow-errors"),
        requirePhases: readRepeatedFlag(verifyArgs, "require-phase"),
        requireComponents: readRepeatedFlag(verifyArgs, "require-component"),
        requireEvents: readRepeatedFlag(verifyArgs, "require-event"),
      });
      if (readBooleanFlag(verifyArgs, "json")) {
        printJson(report);
      } else {
        process.stdout.write(`observability log: ${report.ok ? "ok" : "failed"}\n`);
        process.stdout.write(`events: ${report.summary.eventCount}\n`);
        for (const entry of report.issues) {
          process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
        }
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (subcommand !== "release-passport" || !location) {
      throw new Error("usage: buildchain verify release-passport <file-or-url>");
    }
    const report = await verifyReleasePassport({ passportLocation: location });
    if (readBooleanFlag(verifyArgs, "json")) {
      printJson(report);
    } else {
      process.stdout.write(`release passport: ${report.ok ? "ok" : "failed"}\n`);
      process.stdout.write(`artifacts: ${report.completeness.artifactCount}\n`);
      for (const entry of report.issues) {
        process.stdout.write(`- ${entry.level}: ${entry.code}: ${entry.message}\n`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "explain") {
    const [subcommand = "", ...explainArgs] = args;
    if (subcommand !== "release") {
      throw new Error("usage: buildchain explain release --passport <file-or-url>");
    }
    const passport = readFlag(explainArgs, "passport", "");
    if (!passport) {
      throw new Error("buildchain explain release requires --passport <file-or-url>");
    }
    const explanation = await explainReleasePassport({
      passportLocation: passport,
      forAudience: readFlag(explainArgs, "for", "human"),
    });
    if (readBooleanFlag(explainArgs, "json")) {
      printJson(explanation);
    } else {
      process.stdout.write(`release: ${explanation.release?.tag || "unknown"}\n`);
      process.stdout.write(`trust: ${explanation.trust}\n`);
      process.stdout.write(`next action: ${explanation.nextAction}\n`);
    }
    return;
  }

  if (command === "inspect") {
    const [subcommand = "", ...inspectArgs] = args;
    if (subcommand !== "release") {
      throw new Error("usage: buildchain inspect release --passport <file-or-url>");
    }
    const passport = readFlag(inspectArgs, "passport", "");
    if (!passport) {
      throw new Error("buildchain inspect release requires --passport <file-or-url>");
    }
    const explanation = await explainReleasePassport({
      passportLocation: passport,
      forAudience: readFlag(inspectArgs, "for", "human"),
    });
    printJson(explanation);
    return;
  }

  if (command === "web-surface") {
    runScript("web-surface.mjs", args);
    return;
  }

  if (command === "build-contract") {
    runScript("resolve-build-contract.mjs", args);
    return;
  }

  if (command === "publish-source") {
    const [mode = "lock", ...publishArgs] = args;
    if (mode === "lock" || mode === "manifest") {
      runScript("resolve-publish-source.mjs", ["--mode", mode, ...publishArgs]);
      return;
    }
    if (mode === "verify-lock") {
      runScript("verify-publish-source-lock.mjs", publishArgs);
      return;
    }
    throw new Error(`unsupported publish-source command: ${mode}`);
  }

  throw new Error(`unsupported buildchain command: ${command}`);
}

main().catch((error) => {
  console.error(`buildchain: ${error.message}`);
  process.exitCode = 1;
});
