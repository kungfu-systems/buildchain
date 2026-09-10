#!/usr/bin/env node
import { inspectRuntimeContract, assertRuntimeContractAccepted } from "../runtime-contract-inspection.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
  readBuildchainContractWorld,
} from "../buildchain-contract.js";
import {
  BUILDCHAIN_CONTRACT_LOCK_PATH,
  resolveBuildchainContractLockPath,
} from "../buildchain-layout.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function readCurrentContract(contractPath, runtimeRoot) {
  if (contractPath && fs.existsSync(contractPath)) {
    return readBuildchainContractWorld(contractPath);
  }
  return createBuildchainContractWorld({ root: runtimeRoot || process.cwd() });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  fs.appendFileSync(summaryPath, `${markdown.trim()}\n\n`);
}



export function checkBuildchainContractLock({
  lockPath = env("BUILDCHAIN_CONTRACT_LOCK_PATH") || resolveBuildchainContractLockPath(process.cwd()),
  currentContractPath = env("BUILDCHAIN_CONTRACT_CURRENT_PATH", ".buildchain/runtime/dist/site/buildchain-contract.json"),
  runtimeRoot = env("BUILDCHAIN_RUNTIME_ROOT", ".buildchain/runtime"),
  runtimeRef = env("BUILDCHAIN_RUNTIME_REF"),
  runtimeSha = env("BUILDCHAIN_RUNTIME_SHA"),
  runtimeClass = env("BUILDCHAIN_RUNTIME_CLASS"),
  compatibilityPolicy = env("BUILDCHAIN_CONTRACT_COMPATIBILITY_POLICY"),
  workflowShellRef = env("BUILDCHAIN_WORKFLOW_SHELL_REF"),
  expectedChannel = env("BUILDCHAIN_EXPECTED_CHANNEL"),
  expectedMajor = env("BUILDCHAIN_EXPECTED_MAJOR"),
  allowOpaqueRuntime = boolEnv("BUILDCHAIN_ALLOW_OPAQUE_RUNTIME"),
  issueMode = env("BUILDCHAIN_CONTRACT_DRIFT_ISSUE_MODE", "compatible-and-breaking"),
  issueBodyPath = env("BUILDCHAIN_CONTRACT_DRIFT_ISSUE_BODY", ".buildchain/contract-drift/issue-body.md"),
  repository = env("GITHUB_REPOSITORY"),
  workflow = env("GITHUB_WORKFLOW"),
  runUrl = env("BUILDCHAIN_WORKFLOW_RUN_URL"),
} = {}) {
  const result = inspectRuntimeContract({lockPath, currentContractPath, runtimeRoot, runtimeRef, runtimeSha, runtimeClass, compatibilityPolicy, workflowShellRef, expectedChannel, expectedMajor, allowOpaqueRuntime, issueMode, issueBodyPath, repository, workflow, runUrl});
  appendSummary(result.summary);
  writeGitHubOutputs(result.outputs);
  assertRuntimeContractAccepted(result);
  return result;
}

export function writeBuildchainContractLock({
  output = env("BUILDCHAIN_CONTRACT_LOCK_PATH", BUILDCHAIN_CONTRACT_LOCK_PATH),
  currentContractPath = env("BUILDCHAIN_CONTRACT_CURRENT_PATH", "dist/site/buildchain-contract.json"),
  runtimeRoot = env("BUILDCHAIN_RUNTIME_ROOT", process.cwd()),
  buildchainRef = env("BUILDCHAIN_RUNTIME_REF", "v4"),
  resolvedSha = env("BUILDCHAIN_RUNTIME_SHA"),
  compatibilityPolicy = env("BUILDCHAIN_CONTRACT_COMPATIBILITY_POLICY", "major-compatible"),
  acceptedAt = env("BUILDCHAIN_CONTRACT_ACCEPTED_AT") || new Date().toISOString(),
} = {}) {
  const contractWorld = readCurrentContract(currentContractPath, runtimeRoot);
  const lock = createBuildchainContractLock({
    buildchainRef,
    resolvedSha,
    contractWorld,
    compatibilityPolicy,
    acceptedAt,
  });
  writeJson(output, lock);
  return lock;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "check";
  if (command === "check") {
    checkBuildchainContractLock();
    return;
  }
  if (command === "write-lock") {
    const outputFlag = argv.indexOf("--output");
    const output = outputFlag >= 0 ? argv[outputFlag + 1] : undefined;
    const lock = writeBuildchainContractLock({ output });
    process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
    return;
  }
  throw new Error(`unknown buildchain contract lock command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`buildchain contract lock: ${error.message}`);
    process.exitCode = 1;
  }
}
