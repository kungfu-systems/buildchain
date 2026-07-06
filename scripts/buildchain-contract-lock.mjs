#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
  evaluateBuildchainContractLock,
  readBuildchainContractLock,
  readBuildchainContractWorld,
  renderBuildchainContractDriftIssueBody,
} from "../packages/core/buildchain-contract.js";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

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

function issueModeAllows(mode, evaluation) {
  if (!evaluation.issueRecommended) {
    return false;
  }
  if (mode === "off") {
    return false;
  }
  if (mode === "breaking-only") {
    return evaluation.status === "breaking-drift";
  }
  return mode === "compatible-and-breaking";
}

export function checkBuildchainContractLock({
  lockPath = env("BUILDCHAIN_CONTRACT_LOCK_PATH", "buildchain.contract-lock.json"),
  currentContractPath = env("BUILDCHAIN_CONTRACT_CURRENT_PATH", ".buildchain/runtime/dist/site/buildchain-contract.json"),
  runtimeRoot = env("BUILDCHAIN_RUNTIME_ROOT", ".buildchain/runtime"),
  runtimeRef = env("BUILDCHAIN_RUNTIME_REF"),
  runtimeSha = env("BUILDCHAIN_RUNTIME_SHA"),
  runtimeClass = env("BUILDCHAIN_RUNTIME_CLASS"),
  compatibilityPolicy = env("BUILDCHAIN_CONTRACT_COMPATIBILITY_POLICY"),
  issueMode = env("BUILDCHAIN_CONTRACT_DRIFT_ISSUE_MODE", "compatible-and-breaking"),
  issueBodyPath = env("BUILDCHAIN_CONTRACT_DRIFT_ISSUE_BODY", ".buildchain/contract-drift/issue-body.md"),
  repository = env("GITHUB_REPOSITORY"),
  workflow = env("GITHUB_WORKFLOW"),
  runUrl = env("BUILDCHAIN_WORKFLOW_RUN_URL"),
} = {}) {
  const current = readCurrentContract(currentContractPath, runtimeRoot);
  const lock = readBuildchainContractLock(lockPath);
  const evaluation = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef,
    runtimeSha,
    runtimeClass,
    compatibilityPolicy,
  });
  const shouldIssue = issueModeAllows(issueMode, evaluation);
  if (shouldIssue) {
    const body = renderBuildchainContractDriftIssueBody({
      repository,
      workflow,
      runUrl,
      lockPath,
      evaluation,
    });
    fs.mkdirSync(path.dirname(issueBodyPath), { recursive: true });
    fs.writeFileSync(issueBodyPath, `${body}\n`);
  }
  appendSummary([
    "## Buildchain contract lock",
    "",
    `- Status: \`${evaluation.status}\``,
    `- Compatible: \`${evaluation.compatible ? "true" : "false"}\``,
    `- Runtime ref: \`${runtimeRef || "(unknown)"}\``,
    `- Runtime SHA: \`${runtimeSha || "(unknown)"}\``,
    `- Contract digest: \`${current.contractDigest}\``,
    `- Compatibility digest: \`${current.compatibilityDigest}\``,
    evaluation.reasons?.length ? `- Reasons: ${evaluation.reasons.join("; ")}` : "",
    shouldIssue ? `- Drift issue body: \`${issueBodyPath}\`` : "",
  ].filter(Boolean).join("\n"));
  writeGitHubOutputs({
    "contract-lock-status": evaluation.status,
    "contract-lock-compatible": String(evaluation.compatible === true),
    "contract-lock-drift": String(evaluation.drift === true),
    "contract-lock-issue-needed": String(shouldIssue),
    "contract-lock-issue-body-file": shouldIssue ? issueBodyPath : "",
    "contract-digest": current.contractDigest,
    "contract-compatibility-digest": current.compatibilityDigest,
    "accepted-contract-digest": evaluation.accepted?.contractDigest || "",
    "accepted-buildchain-sha": evaluation.accepted?.resolvedSha || "",
    "current-buildchain-sha": runtimeSha || "",
  });
  if (!evaluation.ok) {
    throw new Error(`Buildchain contract drift is not compatible: ${(evaluation.reasons || []).join("; ")}`);
  }
  return { evaluation, current, shouldIssue };
}

export function writeBuildchainContractLock({
  output = env("BUILDCHAIN_CONTRACT_LOCK_PATH", "buildchain.contract-lock.json"),
  currentContractPath = env("BUILDCHAIN_CONTRACT_CURRENT_PATH", "dist/site/buildchain-contract.json"),
  runtimeRoot = env("BUILDCHAIN_RUNTIME_ROOT", process.cwd()),
  buildchainRef = env("BUILDCHAIN_RUNTIME_REF", "v2"),
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
