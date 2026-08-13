#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  certifyV4FloatingConsumerPolicyReceipt,
  scanV4FloatingConsumerPolicy,
} from "../packages/core/v4-floating-consumer-policy.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const RUNTIME_ROOT = path.resolve(import.meta.dirname, "..");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--") || !argv[index + 1])
      throw new Error(`invalid argument: ${arg}`);
    options[
      arg
        .slice(2)
        .replace(/-([a-z])/gu, (_, character) => character.toUpperCase())
    ] = argv[index + 1];
    index += 1;
  }
  return options;
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function v4ConsumerPolicyScannerRoot(runtimeRoot = RUNTIME_ROOT) {
  const paths = [
    "architecture/v4-floating-consumer-policy.json",
    "contracts/v4-floating-consumer-policy-receipt-v1.schema.json",
    "packages/core/v4-floating-consumer-policy.js",
    "packages/core/workflow-yaml-contract.js",
    "scripts/v4-consumer-policy.mjs",
  ];
  return sha256(
    stableJson(
      paths.map((relative) => ({
        path: relative,
        digest: sha256(fs.readFileSync(path.join(runtimeRoot, relative))),
      })),
    ),
  );
}

export function scanCommand(options = {}) {
  const root = path.resolve(
    options.root || env("BUILDCHAIN_CONSUMER_ROOT", process.cwd()),
  );
  const output = path.resolve(
    root,
    options.output ||
      env(
        "BUILDCHAIN_V4_POLICY_RECEIPT_PATH",
        ".buildchain/evidence/v4-consumer-policy-receipt.json",
      ),
  );
  const policy = readJson(
    path.join(RUNTIME_ROOT, "architecture/v4-floating-consumer-policy.json"),
  );
  const result = scanV4FloatingConsumerPolicy({
    root,
    repository: options.repository || env("GITHUB_REPOSITORY"),
    sourceSha: options.sourceSha || env("GITHUB_SHA"),
    invokedWorkflow:
      options.invokedWorkflow || env("BUILDCHAIN_INVOKED_WORKFLOW"),
    resolvedWorkflowSha:
      options.resolvedWorkflowSha || env("BUILDCHAIN_WORKFLOW_SHA"),
    resolvedRuntimeSha:
      options.resolvedRuntimeSha ||
      env("BUILDCHAIN_RUNTIME_SHA", env("BUILDCHAIN_WORKFLOW_SHA")),
    stableLockPath:
      options.stableLock ||
      env(
        "BUILDCHAIN_STABLE_CONTRACT_LOCK_PATH",
        ".buildchain/contract-lock.json",
      ),
    alphaLockPath:
      options.alphaLock ||
      env(
        "BUILDCHAIN_ALPHA_CONTRACT_LOCK_PATH",
        ".buildchain/alpha-contract-lock.json",
      ),
    policy,
    scannerRoot: v4ConsumerPolicyScannerRoot(),
  });
  writeJson(output, result);
  writeGitHubOutputs({
    "v4-consumer-policy-status": result.ok ? "passed" : "failed",
    "v4-consumer-policy-receipt-path": output,
    "v4-consumer-policy-receipt-root": result.receiptRoot,
    "v4-consumer-policy-receipt-json": JSON.stringify(result.receipt),
    "v4-consumer-policy-channel": result.receipt.invocation.channel,
    "v4-consumer-policy-selector": result.receipt.invocation.visibleSelector,
    "v4-consumer-policy-scanner-root": result.receipt.policy.scannerRoot,
  });
  return result;
}

export function certifyCommand(options = {}) {
  const inputValue = options.input || env("BUILDCHAIN_V4_POLICY_RECEIPT_PATH");
  if (!inputValue) throw new Error("certify requires --input");
  const input = path.resolve(inputValue);
  const document = readJson(input);
  const evidence = document.consumerPolicy || document;
  const receipt = evidence.receipt || evidence;
  const receiptRoot =
    options.receiptRoot ||
    evidence.receiptRoot ||
    document.receiptRoot ||
    env("BUILDCHAIN_V4_POLICY_RECEIPT_ROOT");
  const result = certifyV4FloatingConsumerPolicyReceipt({
    receipt,
    receiptRoot,
    repository:
      options.repository || env("BUILDCHAIN_EXPECTED_CALLER_REPOSITORY"),
    sourceSha:
      options.sourceSha || env("BUILDCHAIN_EXPECTED_CALLER_SOURCE_SHA"),
    invokedWorkflow:
      options.invokedWorkflow || env("BUILDCHAIN_EXPECTED_INVOKED_WORKFLOW"),
    resolvedRuntimeSha:
      options.resolvedRuntimeSha || env("BUILDCHAIN_EXPECTED_RUNTIME_SHA"),
    policyRoot: options.policyRoot || env("BUILDCHAIN_EXPECTED_V4_POLICY_ROOT"),
    scannerRoot:
      options.scannerRoot || env("BUILDCHAIN_EXPECTED_V4_SCANNER_ROOT"),
    stableLockRoot:
      options.stableLockRoot || env("BUILDCHAIN_EXPECTED_STABLE_LOCK_ROOT"),
    alphaLockRoot:
      options.alphaLockRoot || env("BUILDCHAIN_EXPECTED_ALPHA_LOCK_ROOT"),
  });
  const output = path.resolve(
    options.output ||
      env(
        "BUILDCHAIN_V4_POLICY_CERTIFICATION_PATH",
        ".buildchain/evidence/v4-consumer-policy-certification.json",
      ),
  );
  writeJson(output, result);
  writeGitHubOutputs({
    "v4-consumer-policy-certification-status": result.ok
      ? "certified"
      : "rejected",
    "v4-consumer-policy-certification-path": output,
    "v4-consumer-policy-certification-root": result.certificationRoot,
  });
  return result;
}

function main(argv = process.argv.slice(2)) {
  const command = argv.shift();
  const options = parseArgs(argv);
  const result =
    command === "scan"
      ? scanCommand(options)
      : command === "certify"
        ? certifyCommand(options)
        : (() => {
            throw new Error(
              "usage: v4-consumer-policy.mjs <scan|certify> [--option value]",
            );
          })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`v4 consumer policy: ${error.message}`);
    process.exitCode = 1;
  }
}
