#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  certifyV4FloatingConsumerPolicyReceipt,
  resolveV4FloatingConsumerPolicyAuthority,
  scanV4FloatingConsumerPolicy,
  v4ConsumerPolicyScannerRoot,
} from "../packages/core/v4-floating-consumer-policy.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";
const RUNTIME_ROOT = path.resolve(import.meta.dirname, "..");
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
export { v4ConsumerPolicyScannerRoot };
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
    invocationSourcePath:
      options.invocationSourcePath ||
      env("BUILDCHAIN_INVOCATION_SOURCE_PATH", env("GITHUB_WORKFLOW_REF")),
    expectedInvocationChannel:
      options.expectedInvocationChannel ||
      env("BUILDCHAIN_EXPECTED_INVOCATION_CHANNEL"),
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
  const document = readJson(path.resolve(inputValue));
  const evidence = document.consumerPolicy || document;
  const receipt = evidence.receipt || evidence;
  const receiptRoot =
    options.receiptRoot ||
    evidence.receiptRoot ||
    document.receiptRoot ||
    env("BUILDCHAIN_V4_POLICY_RECEIPT_ROOT");
  const callerRoot = path.resolve(
    options.callerRoot || env("BUILDCHAIN_EXPECTED_CALLER_ROOT", process.cwd()),
  );
  const stableLockPath =
    options.stableLock ||
    env(
      "BUILDCHAIN_STABLE_CONTRACT_LOCK_PATH",
      ".buildchain/contract-lock.json",
    );
  const alphaLockPath =
    options.alphaLock ||
    env(
      "BUILDCHAIN_ALPHA_CONTRACT_LOCK_PATH",
      ".buildchain/alpha-contract-lock.json",
    );
  const repository =
    options.repository || env("BUILDCHAIN_EXPECTED_CALLER_REPOSITORY");
  const sourceSha =
    options.sourceSha || env("BUILDCHAIN_EXPECTED_CALLER_SOURCE_SHA");
  const invokedWorkflow =
    options.invokedWorkflow ||
    env("BUILDCHAIN_EXPECTED_INVOKED_WORKFLOW") ||
    receipt?.invocation?.workflow;
  const resolvedRuntimeSha =
    options.resolvedRuntimeSha || env("BUILDCHAIN_EXPECTED_RUNTIME_SHA");
  const authority = resolveV4FloatingConsumerPolicyAuthority({
    runtimeRoot: RUNTIME_ROOT,
    callerRoot,
    stableLockPath,
    alphaLockPath,
  });
  const selectedLock =
    receipt?.invocation?.visibleSelector === "v4-alpha"
      ? readJson(path.join(callerRoot, alphaLockPath))
      : readJson(path.join(callerRoot, stableLockPath));
  const authorityScan = scanV4FloatingConsumerPolicy({
    root: callerRoot,
    repository,
    sourceSha,
    invokedWorkflow,
    invocationSourcePath: receipt?.invocation?.sourcePath,
    expectedInvocationChannel: receipt?.invocation?.channel,
    resolvedWorkflowSha: selectedLock.buildchain?.resolvedSha,
    resolvedRuntimeSha,
    stableLockPath,
    alphaLockPath,
    policy: authority.policy,
    scannerRoot: authority.scannerRoot,
  });
  const certificationAuthority = {
    receiptRoot: authorityScan.receiptRoot,
    policyRoot: authority.policyRoot,
    scannerRoot: authority.scannerRoot,
    contractLocks: authority.contractLocks,
  };
  const result = certifyV4FloatingConsumerPolicyReceipt({
    receipt,
    receiptRoot,
    expectedReceiptRoot: authorityScan.receiptRoot,
    repository,
    sourceSha,
    invokedWorkflow,
    resolvedRuntimeSha,
    policyRoot: authority.policyRoot,
    scannerRoot: authority.scannerRoot,
    stableLockRoot: authority.contractLocks.stable.root,
    alphaLockRoot: authority.contractLocks.alpha.root,
    stableLockPath,
    alphaLockPath,
    authority: certificationAuthority,
  });
  const output = path.resolve(
    options.output ||
      env(
        "BUILDCHAIN_V4_POLICY_CERTIFICATION_PATH",
        ".buildchain/evidence/v4-consumer-policy-certification.json",
      ),
  );
  const documentWithAuthority = {
    ...result,
    authority: certificationAuthority,
  };
  writeJson(output, documentWithAuthority);
  writeGitHubOutputs({
    "v4-consumer-policy-certification-status": result.ok
      ? "certified"
      : "rejected",
    "v4-consumer-policy-certification-path": output,
    "v4-consumer-policy-certification-root": result.certificationRoot,
  });
  return documentWithAuthority;
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
