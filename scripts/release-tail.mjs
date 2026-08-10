#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  compileReleaseTailDeclaration,
  createReleaseTailTransaction,
  readReleaseTailTransaction,
  validateReleaseTailTransaction,
  writeReleaseTailTransaction,
} from "../packages/core/release-tail-provider-plane.js";
import { diagnoseLegacyReleaseTailHooks } from "../packages/core/release-tail-compatibility.js";
import {
  executePublicationRehearsal,
  publicationRehearsalDiagnostic,
} from "../packages/core/publication-rehearsal-runtime.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1] || "";
}

function readJson(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const filePath = path.resolve(value);
  if (fs.existsSync(filePath))
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  return JSON.parse(value);
}

function output(value, filePath = "") {
  if (filePath) {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runReleaseTailCli(args = process.argv.slice(2)) {
  const [mode = "status", ...options] = args;
  if (mode === "rehearse") {
    const capsulePath = flag(options, "capsule");
    const capsuleRoot = flag(options, "capsule-root");
    const statePath = flag(options, "state");
    const evidencePath = flag(options, "evidence");
    for (const [name, value] of Object.entries({
      "--capsule": capsulePath,
      "--capsule-root": capsuleRoot,
      "--state": statePath,
      "--evidence": evidencePath,
    })) {
      if (!value || !path.isAbsolute(value)) {
        throw new Error(`${name} must be an explicit absolute path`);
      }
    }
    const capsule = readJson(capsulePath, "--capsule");
    const rehearsalMode = flag(options, "mode", "simulate");
    if (!new Set(["simulate", "replay"]).has(rehearsalMode)) {
      throw new Error("local rehearsal --mode must be simulate or replay");
    }
    const environment = flag(options, "environment-json")
      ? readJson(flag(options, "environment-json"), "--environment-json")
      : {};
    let result;
    try {
      result = await executePublicationRehearsal({
        capsule,
        capsuleRoot,
        mode: rehearsalMode,
        environment,
        checkpoint: (transaction) =>
          writeReleaseTailTransaction(statePath, transaction),
      });
    } catch (error) {
      const diagnostic = publicationRehearsalDiagnostic(error, { capsule });
      output(diagnostic, evidencePath);
      throw error;
    }
    writeReleaseTailTransaction(statePath, result.transaction);
    output(result.evidence, evidencePath);
    return result;
  }
  if (mode === "plan") {
    const plan = compileReleaseTailDeclaration(
      readJson(flag(options, "declaration"), "--declaration"),
    );
    output(plan, flag(options, "output"));
    return plan;
  }
  if (mode === "init") {
    const transaction = createReleaseTailTransaction(
      readJson(flag(options, "declaration"), "--declaration"),
    );
    const statePath = flag(
      options,
      "state",
      ".buildchain/release-tail/state.json",
    );
    writeReleaseTailTransaction(statePath, transaction);
    output(transaction);
    return transaction;
  }
  if (mode === "status" || mode === "verify") {
    const statePath = flag(
      options,
      "state",
      ".buildchain/release-tail/state.json",
    );
    const transaction = readReleaseTailTransaction(statePath);
    const validation = validateReleaseTailTransaction(transaction);
    const nextOperation = transaction.operations.find(
      (entry) => entry.status === "pending",
    );
    const report = {
      schema: "kungfu.buildchain.release-tail.status/v1",
      ok: validation.valid,
      state: transaction.state,
      stateRoot: transaction.stateRoot,
      transactionRoot: transaction.transactionRoot,
      nextOperation: nextOperation
        ? {
            operationId: nextOperation.operationId,
            capabilityId: nextOperation.capabilityId,
            adapter: nextOperation.effect.adapter,
          }
        : null,
      receiptRoots: transaction.receipts.map((receipt) => receipt.receiptRoot),
      issues: validation.issues,
    };
    output(report, flag(options, "output"));
    return report;
  }
  if (mode === "compat") {
    const report = diagnoseLegacyReleaseTailHooks(
      readJson(flag(options, "hooks-json"), "--hooks-json"),
    );
    output(report, flag(options, "output"));
    if (!report.compatible) process.exitCode = 1;
    return report;
  }
  throw new Error(
    "usage: buildchain release-tail <plan|init|status|verify|compat|rehearse> [--declaration <json-or-path>] [--capsule <path>] [--capsule-root <absolute-path>] [--mode <simulate|replay>] [--state <path>] [--evidence <path>] [--hooks-json <json-or-path>] [--output <path>]",
  );
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runReleaseTailCli();
  } catch (error) {
    console.error(`release-tail: ${error.message}`);
    process.exitCode = 1;
  }
}
