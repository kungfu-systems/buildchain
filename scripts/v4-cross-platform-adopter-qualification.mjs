#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createV4CrossPlatformAdopterReport,
  qualifyV4CrossPlatformAdopters,
  summarizeV3V4CapabilityInventory,
} from "../packages/core/v4-cross-platform-adopter-qualification.js";

function flag(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function required(name) {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function repeated(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1])
      values.push(process.argv[++index]);
  }
  return values;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const completed = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (completed.error) throw completed.error;
  return completed;
}

function expectPass(result, label) {
  if (result.status !== 0)
    throw new Error(
      `${label} failed with ${result.status}: ${(result.stderr || "").trim()}`,
    );
}

function resolveInput(consumerRoot, value) {
  return path.isAbsolute(value) ? value : path.join(consumerRoot, value);
}

function runPlatform() {
  const runtimeRoot = path.resolve(required("runtime-root"));
  const consumerRoot = path.resolve(flag("consumer-root", process.cwd()));
  const output = path.resolve(required("output"));
  const workRoot = path.dirname(output);
  const input = resolveInput(consumerRoot, required("input"));
  const bootstrap = resolveInput(consumerRoot, required("bootstrap"));
  const cli = path.join(runtimeRoot, "bin/buildchain.mjs");
  const command = (subcommand, args) =>
    run(process.execPath, [cli, "adopter-delivery", subcommand, ...args], {
      cwd: consumerRoot,
      env: process.env,
    });

  const inventory = readJson(
    path.join(runtimeRoot, "architecture/v3-v4-live-capability-inventory.json"),
  );
  const inventoryEvidence = summarizeV3V4CapabilityInventory(inventory);
  fs.mkdirSync(workRoot, { recursive: true });
  const initialPath = path.join(workRoot, "initial-readback.json");
  const retryPath = path.join(workRoot, "retry-readback.json");
  const terminalPath = path.join(workRoot, "terminal-readback.json");
  const tamperedPath = path.join(workRoot, "tampered-readback.json");
  const bootstrapPath = path.join(workRoot, "bootstrap.json");

  expectPass(
    command("run", ["--input", input, "--output", initialPath]),
    "initial public adopter delivery",
  );
  const initial = readJson(initialPath);
  const tampered = structuredClone(initial);
  tampered.gateResult.artifact.root = `sha256:${"f".repeat(64)}`;
  writeJson(tamperedPath, tampered);
  const rejected = command("verify", [
    "--input",
    input,
    "--readback",
    tamperedPath,
  ]);
  if (rejected.status === 0)
    throw new Error("tampered public readback was not rejected");
  expectPass(
    command("run", ["--input", input, "--output", retryPath]),
    "retry public adopter delivery",
  );
  const retry = readJson(retryPath);
  expectPass(
    command("verify", [
      "--input",
      input,
      "--readback",
      retryPath,
      "--output",
      terminalPath,
    ]),
    "terminal public adopter delivery readback",
  );
  const terminal = readJson(terminalPath);
  expectPass(
    command("bootstrap", ["--input", bootstrap, "--output", bootstrapPath]),
    "public N-1 bootstrap",
  );
  const bootstrapEvidence = readJson(bootstrapPath);
  const neutralDriver = run(
    process.execPath,
    [
      "--test",
      path.join(
        runtimeRoot,
        "tests/non-kfd-specification-driver-clean-room.test.mjs",
      ),
    ],
    { cwd: runtimeRoot, env: process.env },
  );
  expectPass(neutralDriver, "independent protocol-neutral driver");

  const report = createV4CrossPlatformAdopterReport({
    platform: required("platform"),
    consumer: required("consumer"),
    sourceBinding: {
      runtimeSha: required("runtime-sha"),
      consumerSha: required("consumer-sha"),
      inventoryRoot: inventoryEvidence.inventoryRoot,
      sourceCuts: inventoryEvidence.sourceCuts,
    },
    capabilityMatrix: {
      capabilityCount: inventoryEvidence.summary.capabilityCount,
      categoryCounts: inventoryEvidence.summary.categoryCounts,
      dispositionCounts: inventoryEvidence.summary.dispositionCounts,
      categories: inventoryEvidence.categories,
    },
    execution: {
      initialRun: {
        status: "passed",
        readbackRoot: initial.deliveryRoot,
      },
      tamperFailure: {
        status: "failed-as-required",
        exitCode: rejected.status ?? 1,
      },
      retryRun: {
        status: "passed",
        readbackRoot: retry.deliveryRoot,
      },
      terminalVerify: {
        status: "passed",
        readbackRoot: terminal.deliveryRoot,
      },
      bootstrap: {
        status: "passed",
        resultRoot: bootstrapEvidence.resultRoot,
      },
      neutralDriver: {
        id: "ledger-specification-driver",
        status: "passed",
        kfdDependencyPresent: false,
      },
    },
    authority: {
      productionWrites: false,
      providerEffects: false,
      releaseEffects: false,
      stablePublication: false,
    },
  });
  writeJson(output, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function collectReports(root) {
  const reports = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const candidate = readJson(target);
        if (
          candidate?.contract ===
          "kungfu-buildchain-v4-cross-platform-adopter-report/v1"
        )
          reports.push(candidate);
      }
    }
  };
  visit(root);
  return reports;
}

function aggregate() {
  const reportsRoot = path.resolve(required("reports-root"));
  const qualification = qualifyV4CrossPlatformAdopters({
    reports: collectReports(reportsRoot),
    consumers: repeated("consumer"),
  });
  const output = flag("output");
  if (output) writeJson(path.resolve(output), qualification);
  process.stdout.write(`${JSON.stringify(qualification, null, 2)}\n`);
}

const mode = process.argv[2] || "";
if (mode === "run") runPlatform();
else if (mode === "aggregate") aggregate();
else
  throw new Error(
    "usage: v4-cross-platform-adopter-qualification.mjs <run|aggregate> ...",
  );
