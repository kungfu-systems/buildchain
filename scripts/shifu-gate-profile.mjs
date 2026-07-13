#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveRunnerMatrix,
  writeGitHubOutputs,
} from "./build-contract-core.mjs";
import {
  createGateAggregate,
  createGateExecutionMatrix,
  normalizeGatePlatform,
} from "./gate-profile-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function commandForPlatform(commandJson, platform) {
  const parsed = parseJson(commandJson, "gate-command-json");
  const argv = Array.isArray(parsed) ? parsed : parsed?.[platform];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(
      `gate-command-json requires a non-empty argv array for ${platform}`,
    );
  }
  return argv;
}

function gateEnvironment() {
  const parsed = parseJson(
    process.env.BUILDCHAIN_GATE_ENVIRONMENT_JSON || "{}",
    "gate-environment-json",
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("gate-environment-json must be a JSON object");
  }
  const entries = Object.entries(parsed).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`invalid Gate environment name: ${name}`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(
        `Gate environment ${name} must be a string, number, or boolean`,
      );
    }
    return [name, String(value)];
  });
  return {
    ...process.env,
    ...Object.fromEntries(entries),
    ...(process.env.BUILDCHAIN_SHIFU_CACHE_PROFILE_REF
      ? {
          SHIFU_CACHE_PROFILE_REF:
            process.env.BUILDCHAIN_SHIFU_CACHE_PROFILE_REF,
        }
      : {}),
    ...(process.env.BUILDCHAIN_SHIFU_CACHE_PROFILE_DIGEST
      ? {
          SHIFU_CACHE_PROFILE_DIGEST:
            process.env.BUILDCHAIN_SHIFU_CACHE_PROFILE_DIGEST,
        }
      : {}),
  };
}

function cmdQuote(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function runArgv(
  argv,
  args,
  { cwd, env = process.env, allowFailure = false } = {},
) {
  const command = argv[0];
  const commandArgs = [...argv.slice(1), ...args];
  const windowsBatch =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const result = windowsBatch
    ? spawnSync(
        process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", [command, ...commandArgs].map(cmdQuote).join(" ")],
        {
          cwd,
          env,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      )
    : spawnSync(command, commandArgs, {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!allowFailure && status !== 0)
    throw new Error(`${command} exited with status ${status}`);
  return { ...result, status };
}

function gateArgs(base, registry) {
  return registry ? [...base, "--registry", registry] : base;
}

function planMode() {
  const profile = process.env.BUILDCHAIN_GATE_PROFILE || "";
  const includeAdvisory =
    process.env.BUILDCHAIN_GATE_INCLUDE_ADVISORY === "true";
  const commandJson =
    process.env.BUILDCHAIN_GATE_PLAN_COMMAND_JSON ||
    process.env.BUILDCHAIN_GATE_COMMAND_JSON ||
    '["./shifu"]';
  const registry = process.env.BUILDCHAIN_GATE_REGISTRY || "";
  const cwd = path.resolve(
    process.env.BUILDCHAIN_GATE_SOURCE_CWD || process.cwd(),
  );
  const outputRoot = path.resolve(
    process.env.BUILDCHAIN_GATE_OUTPUT_ROOT || ".buildchain/gates/plan",
  );
  const env = gateEnvironment();
  const resolvedRunners = resolveRunnerMatrix({
    runnerPreset: process.env.BUILDCHAIN_RUNNER_PRESET || "github-hosted",
    platformsJson: process.env.BUILDCHAIN_PLATFORMS_JSON || "",
  });
  const platforms = resolvedRunners.platforms.map(normalizeGatePlatform);
  const plans = {};
  for (const platform of platforms) {
    const argv = commandForPlatform(
      commandJson,
      process.platform === "win32" ? "windows" : "linux",
    );
    const args = gateArgs(
      [
        "gate",
        "plan",
        profile,
        "--platform",
        platform.platform,
        ...(includeAdvisory ? ["--include-advisory"] : []),
        "--json",
      ],
      registry,
    );
    const result = runArgv(argv, args, { cwd, env });
    const plan = parseJson(result.stdout, `Shifu gate plan for ${platform.id}`);
    plans[platform.id] = plan;
    writeJson(path.join(outputRoot, "plans", `${platform.id}.json`), plan);
  }
  const matrix = createGateExecutionMatrix({
    profile,
    includeAdvisory,
    platforms,
    plans,
  });
  const matrixPath = path.join(outputRoot, "matrix.json");
  writeJson(matrixPath, matrix);
  writeGitHubOutputs({
    "gate-matrix-json": JSON.stringify(matrix.entries),
    "gate-matrix-count": String(matrix.entries.length),
    "gate-matrix-digest": matrix.digest,
    "gate-matrix-path": matrixPath,
    "gate-project-id": matrix.registry.projectId,
    "gate-registry-digest": matrix.registry.digest,
  });
  return matrix;
}

function runMode() {
  const entry = parseJson(
    process.env.BUILDCHAIN_GATE_MATRIX_ENTRY_JSON || "",
    "gate matrix entry",
  );
  const commandJson = process.env.BUILDCHAIN_GATE_COMMAND_JSON || '["./shifu"]';
  const registry = process.env.BUILDCHAIN_GATE_REGISTRY || "";
  const cwd = path.resolve(
    process.env.BUILDCHAIN_GATE_SOURCE_CWD || process.cwd(),
  );
  const outputRoot = path.resolve(
    process.env.BUILDCHAIN_GATE_OUTPUT_ROOT ||
      `.buildchain/gates/executions/${entry.id}`,
  );
  const receiptPath = path.join(outputRoot, "receipt.json");
  const validationPath = path.join(outputRoot, "validation.json");
  const executionPath = path.join(outputRoot, "execution.json");
  const env = gateEnvironment();
  fs.mkdirSync(outputRoot, { recursive: true });
  const argv = commandForPlatform(commandJson, entry.platform);
  const runArgs = gateArgs(
    [
      "gate",
      "run",
      "--profile",
      entry.profile,
      ...(entry.includeAdvisory ? ["--include-advisory"] : []),
      ...entry.capabilities.flatMap((capability) => [
        "--capability",
        capability,
      ]),
      "--receipt",
      receiptPath,
      "--json",
    ],
    registry,
  );
  const runResult = runArgv(argv, runArgs, { cwd, env, allowFailure: true });
  let receipt = fs.existsSync(receiptPath)
    ? readJson(receiptPath, "Shifu gate receipt")
    : null;
  let validation = null;
  let validationStatus = 1;
  if (receipt) {
    const validationResult = runArgv(
      argv,
      gateArgs(
        ["gate", "receipt", "validate", receiptPath, "--json"],
        registry,
      ),
      { cwd, env, allowFailure: true },
    );
    validationStatus = validationResult.status;
    if (validationResult.stdout.trim()) {
      validation = parseJson(
        validationResult.stdout,
        "Shifu gate receipt validation",
      );
      writeJson(validationPath, validation);
    }
  }
  const execution = {
    platformId: entry.id,
    runStatus: runResult.status,
    validationStatus,
    receipt,
    validation,
  };
  writeJson(executionPath, execution);
  writeGitHubOutputs({
    "gate-platform-id": entry.id,
    "gate-receipt-path": receipt ? receiptPath : "",
    "gate-validation-path": validation ? validationPath : "",
    "gate-execution-path": executionPath,
    "gate-qualifying": String(
      receipt?.qualifying === true && validation?.qualifying === true,
    ),
  });
  if (
    runResult.status !== 0 ||
    validationStatus !== 0 ||
    validation?.qualifying !== true
  ) {
    process.exitCode = 1;
  }
  return execution;
}

function findNamedFiles(root, basename) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return path.basename(root) === basename ? [root] : [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findNamedFiles(path.join(root, entry.name), basename));
}

function aggregateMode() {
  const matrixPath = path.resolve(
    process.env.BUILDCHAIN_GATE_MATRIX_PATH || "",
  );
  const inputRoot = path.resolve(
    process.env.BUILDCHAIN_GATE_EXECUTION_INPUT || "",
  );
  const outputPath = path.resolve(
    process.env.BUILDCHAIN_GATE_AGGREGATE_PATH ||
      ".buildchain/gates/gate-aggregate.json",
  );
  const sourceSha = process.env.BUILDCHAIN_GATE_SOURCE_SHA || "";
  const matrix = readJson(matrixPath, "gate matrix");
  const executions = new Map();
  for (const file of findNamedFiles(inputRoot, "execution.json")) {
    const execution = readJson(file, "gate execution");
    if (!execution.platformId) throw new Error(`${file} is missing platformId`);
    if (executions.has(execution.platformId))
      throw new Error(`duplicate gate execution for ${execution.platformId}`);
    executions.set(execution.platformId, execution);
  }
  const aggregate = createGateAggregate({ matrix, sourceSha, executions });
  writeJson(outputPath, aggregate);
  writeGitHubOutputs({
    "gate-aggregate-path": outputPath,
    "gate-aggregate-json": JSON.stringify(aggregate),
    "gate-aggregate-digest": aggregate.digest,
    "gate-aggregate-status": aggregate.status,
    "gate-aggregate-qualifying": String(aggregate.qualifying),
  });
  if (!aggregate.qualifying) process.exitCode = 1;
  return aggregate;
}

export function shifuGateProfileCli() {
  const mode = readArg("mode", process.env.BUILDCHAIN_GATE_MODE || "plan");
  if (mode === "plan") return planMode();
  if (mode === "run") return runMode();
  if (mode === "aggregate") return aggregateMode();
  throw new Error(`unsupported Shifu gate profile mode: ${mode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    shifuGateProfileCli();
  } catch (error) {
    console.error(
      `::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`,
    );
    process.exitCode = 1;
  }
}
