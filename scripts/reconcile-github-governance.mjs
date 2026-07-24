#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GITHUB_GOVERNANCE_ROLLOUT_CONTRACT,
  createGithubGovernanceRolloutPlan,
  githubGovernanceDigest,
  normalizeGithubBranchProtectionSnapshot,
} from "../packages/core/github-governance-authority.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1] || "");
}

function repeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) values.push(String(args[index + 1] || ""));
  }
  return values.filter(Boolean);
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch {
    throw new Error(`${label} must be a readable JSON file`);
  }
}

function githubApi(route, { method = "GET", body } = {}) {
  const args = [
    "api",
    route,
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (body !== undefined && body !== null) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body !== undefined && body !== null ? `${JSON.stringify(body)}\n` : undefined,
    timeout: 60_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    if (/404|not found/i.test(output)) return { exists: false, data: null };
    throw new Error(`GitHub API ${method} ${route} failed closed`);
  }
  return {
    exists: method !== "DELETE",
    data: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function protectionEndpoint(repository, branch) {
  return `repos/${repository}/branches/${encodeURIComponent(branch)}/protection`;
}

function readProtection(repository, branch) {
  const response = githubApi(protectionEndpoint(repository, branch));
  return {
    exists: response.exists,
    body: response.exists
      ? normalizeGithubBranchProtectionSnapshot(response.data)
      : null,
  };
}

function snapshotCore(repository, branch, protection) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-github-governance-rollback-snapshot",
    repository,
    targetRef: branch,
    protectionExists: protection.exists,
    protection: protection.body,
  };
}

function verifyPlan(plan) {
  if (plan?.contract !== GITHUB_GOVERNANCE_ROLLOUT_CONTRACT) {
    throw new Error("rollout plan contract mismatch");
  }
  const { planRoot, ...core } = plan;
  if (planRoot !== githubGovernanceDigest(core)) {
    throw new Error("rollout plan root mismatch");
  }
  return plan;
}

function plan(args) {
  const repository = required(flag(args, "repository"), "--repository");
  const branch = required(flag(args, "branch"), "--branch").replace(/^refs\/heads\//, "");
  const checks = repeatedFlag(args, "required-check");
  if (checks.length === 0) {
    throw new Error("at least one --required-check is required");
  }
  const snapshotOutput = required(flag(args, "snapshot-output"), "--snapshot-output");
  const planOutput = required(flag(args, "plan-output"), "--plan-output");
  const protection = readProtection(repository, branch);
  const snapshot = snapshotCore(repository, branch, protection);
  const snapshotWithRoot = {
    ...snapshot,
    snapshotRoot: githubGovernanceDigest(snapshot),
  };
  const rollout = createGithubGovernanceRolloutPlan({
    repository,
    targetRef: branch,
    inventory: {
      protectionExists: protection.exists,
      protection: protection.body,
    },
    rollbackSnapshot: protection.body || {},
    rollbackProtectionExists: protection.exists,
    desiredProtection: {
      strictRequiredChecks: hasFlag(args, "strict-required-checks"),
      requiredChecks: checks,
      requiredApprovals: Number(flag(args, "required-approvals", "1")),
    },
  });
  const bound = {
    ...rollout,
    snapshotRoot: snapshotWithRoot.snapshotRoot,
    snapshotPath: path.resolve(snapshotOutput),
  };
  const { planRoot: ignored, ...boundCore } = bound;
  const finalPlan = {
    ...boundCore,
    planRoot: githubGovernanceDigest(boundCore),
  };
  fs.writeFileSync(path.resolve(snapshotOutput), `${JSON.stringify(snapshotWithRoot, null, 2)}\n`);
  fs.writeFileSync(path.resolve(planOutput), `${JSON.stringify(finalPlan, null, 2)}\n`);
  return finalPlan;
}

function apply(args) {
  const planPath = required(flag(args, "plan-json"), "--plan-json");
  const confirmed = required(flag(args, "confirm-plan-root"), "--confirm-plan-root");
  const rollout = verifyPlan(readJson(planPath, "rollout plan"));
  if (rollout.planRoot !== confirmed) {
    throw new Error("--confirm-plan-root does not match the frozen rollout plan");
  }
  const snapshot = readJson(rollout.snapshotPath, "rollback snapshot");
  const { snapshotRoot, ...snapshotBody } = snapshot;
  if (snapshotRoot !== rollout.snapshotRoot ||
      snapshotRoot !== githubGovernanceDigest(snapshotBody)) {
    throw new Error("rollback snapshot root mismatch");
  }
  const current = readProtection(rollout.repository, rollout.targetRef);
  const currentInventoryRoot = githubGovernanceDigest({
    protectionExists: current.exists,
    protection: current.body,
  });
  if (currentInventoryRoot !== rollout.inventoryRoot) {
    throw new Error("live GitHub protection drifted after planning; apply stopped");
  }
  for (const operation of rollout.operations) {
    githubApi(operation.endpoint, {
      method: operation.method,
      body: operation.body,
    });
  }
  const after = readProtection(rollout.repository, rollout.targetRef);
  if (!after.exists) throw new Error("post-change branch protection is absent");
  const expected = rollout.expectedObservation;
  const actualChecks = (after.body.required_status_checks?.checks || [])
    .map((entry) => entry.context)
    .sort();
  if (
    after.body.enforce_admins !== true ||
    after.body.required_pull_request_reviews?.require_code_owner_reviews !== true ||
    after.body.required_pull_request_reviews?.dismiss_stale_reviews !== true ||
    after.body.required_pull_request_reviews?.require_last_push_approval !== true ||
    after.body.required_conversation_resolution !== true ||
    after.body.allow_force_pushes !== false ||
    after.body.allow_deletions !== false ||
    JSON.stringify(actualChecks) !== JSON.stringify([...expected.requiredChecks].sort())
  ) {
    throw new Error("post-change GitHub read-back does not match the rollout plan");
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-github-governance-rollout-receipt",
    status: "applied",
    planRoot: rollout.planRoot,
    snapshotRoot: rollout.snapshotRoot,
    afterRoot: githubGovernanceDigest(after.body),
    repository: rollout.repository,
    targetRef: rollout.targetRef,
  };
}

function rollback(args) {
  const planPath = required(flag(args, "plan-json"), "--plan-json");
  const confirmed = required(flag(args, "confirm-rollback-root"), "--confirm-rollback-root");
  const rollout = verifyPlan(readJson(planPath, "rollout plan"));
  if (rollout.snapshotRoot !== confirmed) {
    throw new Error("--confirm-rollback-root does not match the frozen rollback snapshot");
  }
  const operation = rollout.rollback[0];
  githubApi(operation.endpoint, {
    method: operation.method,
    body: operation.body,
  });
  const after = readProtection(rollout.repository, rollout.targetRef);
  const restored = after.exists ? after.body : {};
  if (githubGovernanceDigest(restored) !== operation.preconditionRoot) {
    throw new Error("rollback read-back does not match the frozen snapshot");
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-github-governance-rollback-receipt",
    status: "restored",
    planRoot: rollout.planRoot,
    snapshotRoot: rollout.snapshotRoot,
    repository: rollout.repository,
    targetRef: rollout.targetRef,
  };
}

function main(args = process.argv.slice(2)) {
  const mode = args[0] || "plan";
  const rest = ["plan", "apply", "rollback"].includes(mode) ? args.slice(1) : args;
  const result = mode === "apply"
    ? apply(rest)
    : mode === "rollback"
      ? rollback(rest)
      : plan(rest);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
