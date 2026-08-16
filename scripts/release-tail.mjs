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
  V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
  executeV4PublicationRehearsal,
} from "../packages/core/v4-publication-rehearsal.js";

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
    const candidateRoot = flag(options, "candidate-root");
    const statePath = flag(options, "state");
    const evidencePath = flag(options, "evidence");
    for (const [name, value] of Object.entries({
      "--capsule": capsulePath,
      "--candidate-root": candidateRoot,
      "--state": statePath,
      "--evidence": evidencePath,
    }))
      if (!value || !path.isAbsolute(value))
        throw new Error(`${name} must be an explicit absolute path`);
    const rehearsalMode = flag(options, "mode", "simulate");
    if (!new Set(["simulate", "replay"]).has(rehearsalMode))
      throw new Error(
        "local rehearsal --mode must be simulate or replay; authorized provider rehearsal uses the reusable workflow",
      );
    try {
      const result = await executeV4PublicationRehearsal({
        capsule: readJson(capsulePath, "--capsule"),
        candidateRoot,
        mode: rehearsalMode,
        checkpoint: (transaction) =>
          writeReleaseTailTransaction(statePath, transaction),
      });
      writeReleaseTailTransaction(statePath, result.transaction);
      output(result.evidence, evidencePath);
      return result;
    } catch (error) {
      output(
        {
          schema: V4_PUBLICATION_REHEARSAL_EVIDENCE_CONTRACT,
          status: "rejected",
          code: error.code || "publication-rehearsal-runtime-error",
          message: error.message,
          productionAuthority: false,
          releasePassport: null,
        },
        evidencePath,
      );
      throw error;
    }
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
    "usage: buildchain release-tail <plan|init|status|verify|compat|rehearse> [--declaration <json-or-path>] [--capsule <absolute-path>] [--candidate-root <absolute-path>] [--mode <simulate|replay>] [--state <absolute-path>] [--evidence <absolute-path>] [--hooks-json <json-or-path>] [--output <path>]",
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
