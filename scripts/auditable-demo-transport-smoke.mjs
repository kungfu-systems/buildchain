#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  prepareArtifact,
  validateScenario,
} from "./auditable-demo-platform.mjs";

const NON_AUTHORITIES = [
  "first-party-identity",
  "system-identity",
  "kfd-compliance",
  "product-system-metadata",
  "package-metadata",
  "registry-history",
  "scan-output",
  "standalone-generation",
];

function fail(message) {
  throw new Error(`auditable demo transport smoke: ${message}`);
}

function inside(root, relative, label) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    fail(`${label} must be relative`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (
    resolved === resolvedRoot ||
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  )
    fail(`${label} escapes its root`);
  return resolved;
}

function removeExecuteBits(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) removeExecuteBits(file);
    else if (entry.isFile())
      fs.chmodSync(file, fs.statSync(file).mode & ~0o111);
  }
}

function isolatedEnvironment(home, declared) {
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "true",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  };
  for (const [key, value] of Object.entries(declared)) {
    if (Object.hasOwn(env, key))
      fail(
        `scenario environment may not override the isolated baseline: ${key}`,
      );
    env[key] = value;
  }
  return env;
}

export function runTransportSmoke({ artifactRoot, scenarioPath }) {
  if (process.platform === "win32")
    fail("transport smoke currently requires a POSIX host");
  const root = path.resolve(artifactRoot);
  const scenario = validateScenario(
    JSON.parse(fs.readFileSync(path.resolve(scenarioPath), "utf8")),
  );
  if (!scenario.transportSmoke) fail("scenario.transportSmoke is required");
  const distributionRelative = path.posix.dirname(
    scenario.artifact.metadataPath,
  );
  const sourceDistribution =
    distributionRelative === "."
      ? root
      : inside(root, distributionRelative, "distribution root");
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-demo-transport-"),
  );
  try {
    const transportedRoot = path.join(temporaryRoot, "artifact");
    const transportedDistribution =
      distributionRelative === "."
        ? transportedRoot
        : path.join(transportedRoot, ...distributionRelative.split("/"));
    fs.mkdirSync(path.dirname(transportedDistribution), { recursive: true });
    fs.cpSync(sourceDistribution, transportedDistribution, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    removeExecuteBits(transportedDistribution);
    const prepared = prepareArtifact({
      artifactRoot: transportedRoot,
      scenarioPath,
    });
    const binary = inside(
      transportedRoot,
      scenario.artifact.binaryPath,
      "transport smoke binary",
    );
    const workspace = path.join(temporaryRoot, "workspace");
    const home = path.join(temporaryRoot, "home");
    fs.mkdirSync(workspace);
    fs.mkdirSync(home);
    const smoke = scenario.transportSmoke;
    const result = spawnSync(binary, smoke.argv, {
      cwd: workspace,
      env: isolatedEnvironment(home, scenario.execution.environment),
      encoding: "utf8",
      timeout: smoke.timeoutSeconds * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (result.error) fail(`could not execute: ${result.error.message}`);
    if (!smoke.expectedExitCodes.includes(result.status))
      fail(`exited with ${result.status}; output: ${output.slice(-4096)}`);
    for (const expected of smoke.stdoutIncludes)
      if (!output.includes(expected)) fail(`output is missing: ${expected}`);
    return {
      schema: "buildchain.declarative-demo-transport-smoke/v1",
      status: "passed",
      executableFiles: prepared.executableFiles,
      argv: smoke.argv,
      exitCode: result.status,
      outputRoot: `sha256:${crypto.createHash("sha256").update(output).digest("hex")}`,
      authority: {
        classification: "pre-upload-transport-diagnostic",
        grants: [],
        nonAuthorities: NON_AUTHORITIES,
      },
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2)
    values[argv[index].replace(/^--/u, "")] = argv[index + 1];
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...runTransportSmoke({ artifactRoot: args["artifact-root"], scenarioPath: args.scenario }) }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
