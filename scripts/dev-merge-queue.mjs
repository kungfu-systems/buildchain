import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";

const RULESET_PREFIX = "Buildchain dev merge queue";
const RULESET_BYPASS_TYPES = new Set(["Integration", "Team", "User"]);

function positiveInteger(value, label, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeRulesetBypassActors(actors = []) {
  const normalized = [];
  const seen = new Set();
  for (const actor of actors) {
    const actorType = requiredString(actor?.actor_type, "ruleset bypass actor type");
    const actorId = Number(actor?.actor_id);
    if (!RULESET_BYPASS_TYPES.has(actorType)) {
      throw new Error(`ruleset bypass actor type must be Integration, Team, or User, got '${actorType}'`);
    }
    if (!Number.isInteger(actorId) || actorId < 1) {
      throw new Error("ruleset bypass actor id must be a positive integer");
    }
    const key = `${actorType}:${actorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ actor_id: actorId, actor_type: actorType, bypass_mode: "always" });
  }
  return normalized;
}

export async function resolveRulesetBypassActors({
  api,
  repository,
  apps = [],
  users = [],
  teams = [],
} = {}) {
  const [owner] = requiredString(repository, "repository").split("/");
  const actors = [];
  for (const slug of apps) {
    const app = await api.request("GET", `apps/${encodeURIComponent(requiredString(slug, "bypass app"))}`);
    actors.push({ actor_id: app.id, actor_type: "Integration" });
  }
  for (const login of users) {
    const user = await api.request("GET", `users/${encodeURIComponent(requiredString(login, "bypass user"))}`);
    actors.push({ actor_id: user.id, actor_type: "User" });
  }
  for (const slug of teams) {
    const team = await api.request(
      "GET",
      `orgs/${encodeURIComponent(owner)}/teams/${encodeURIComponent(requiredString(slug, "bypass team"))}`,
    );
    actors.push({ actor_id: team.id, actor_type: "Team" });
  }
  return normalizeRulesetBypassActors(actors);
}

export function selectMergeQueueMethod(repositorySettings = {}) {
  const candidates = [
    ["MERGE", repositorySettings.allow_merge_commit],
    ["SQUASH", repositorySettings.allow_squash_merge],
    ["REBASE", repositorySettings.allow_rebase_merge],
  ];
  const selected = candidates.find(([, allowed]) => allowed === true)?.[0];
  if (!selected) {
    throw new Error("repository must allow at least one merge method before merge queue enablement");
  }
  return selected;
}

function assertMergeQueueMethod(method, repositorySettings = {}) {
  const normalized = requiredString(method, "merge queue method").toUpperCase();
  const allowed = {
    MERGE: repositorySettings.allow_merge_commit === true,
    SQUASH: repositorySettings.allow_squash_merge === true,
    REBASE: repositorySettings.allow_rebase_merge === true,
  };
  if (!(normalized in allowed) || !allowed[normalized]) {
    throw new Error(`inherited merge queue method '${normalized}' is not enabled by the repository`);
  }
  return normalized;
}

export function validateMergeGroupWorkflows(workflows = []) {
  if (workflows.length === 0) {
    throw new Error("at least one required workflow must be declared with --workflow");
  }
  const results = workflows.map(({ path: workflowPath, source }) => {
    const hasPullRequest = /^\s{0,4}pull_request\s*:/m.test(source);
    const hasMergeGroup = /^\s{0,4}merge_group\s*:/m.test(source);
    const usesPullRequestPayload = /github\.event\.pull_request/.test(source);
    return { path: workflowPath, hasPullRequest, hasMergeGroup, usesPullRequestPayload };
  });
  const invalid = results.filter((workflow) => !workflow.hasPullRequest || !workflow.hasMergeGroup);
  if (invalid.length > 0) {
    throw new Error(
      `merge queue requires pull_request and merge_group triggers in every required workflow: ${invalid.map((entry) => entry.path).join(", ")}`,
    );
  }
  const payloadBound = results.filter((workflow) => workflow.usesPullRequestPayload);
  if (payloadBound.length > 0) {
    throw new Error(
      `merge queue workflows must not depend directly on github.event.pull_request: ${payloadBound.map((entry) => entry.path).join(", ")}`,
    );
  }
  return results;
}

export function createDevMergeQueuePlan({
  repository,
  branch,
  workflows,
  protection,
  repositorySettings,
  rulesets = [],
  bypassActors = [],
  checkResponseTimeoutMinutes = 120,
  maxEntriesToBuild = 1,
  queueParameters = {},
  allowInheritedWorkflowEvidence = false,
} = {}) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedBranch = requiredString(branch, "branch");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalizedBranch)) {
    throw new Error(`branch must be a Buildchain dev channel, got '${normalizedBranch}'`);
  }
  const workflowChecks = workflows.length === 0 && allowInheritedWorkflowEvidence
    ? []
    : validateMergeGroupWorkflows(workflows);
  const mergeMethod = queueParameters.merge_method
    ? assertMergeQueueMethod(queueParameters.merge_method, repositorySettings)
    : selectMergeQueueMethod(repositorySettings);
  const requiredChecks = protection?.required_status_checks?.checks || [];
  if (requiredChecks.length === 0) {
    throw new Error(`protected branch ${normalizedBranch} must declare required status checks before merge queue enablement`);
  }
  const rulesetName = `${RULESET_PREFIX}: ${normalizedBranch}`;
  const existingRuleset = rulesets.find((entry) => entry?.name === rulesetName);
  const ruleset = {
    name: rulesetName,
    target: "branch",
    enforcement: "active",
    bypass_actors: normalizeRulesetBypassActors(bypassActors),
    conditions: {
      ref_name: {
        include: [`refs/heads/${normalizedBranch}`],
        exclude: [],
      },
    },
    rules: [{
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: positiveInteger(
          queueParameters.check_response_timeout_minutes || checkResponseTimeoutMinutes,
          "check response timeout",
          120,
        ),
        grouping_strategy: queueParameters.grouping_strategy || "ALLGREEN",
        max_entries_to_build: positiveInteger(
          queueParameters.max_entries_to_build || maxEntriesToBuild,
          "max entries to build",
          1,
        ),
        max_entries_to_merge: positiveInteger(queueParameters.max_entries_to_merge, "max entries to merge", 1),
        merge_method: mergeMethod,
        min_entries_to_merge: positiveInteger(queueParameters.min_entries_to_merge, "min entries to merge", 1),
        min_entries_to_merge_wait_minutes: Number.isInteger(queueParameters.min_entries_to_merge_wait_minutes)
          ? queueParameters.min_entries_to_merge_wait_minutes
          : 0,
      },
    }],
  };
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-dev-merge-queue-policy",
    repository: normalizedRepository,
    branch: normalizedBranch,
    ok: true,
    workflowChecks,
    workflowEvidence: workflowChecks.length > 0 ? "declared-workflows" : "inherited-active-ruleset",
    before: {
      strict: protection.required_status_checks?.strict === true,
      requiredStatusChecks: requiredChecks.map((check) => check.context),
      rulesetId: existingRuleset?.id || null,
    },
    desired: {
      strict: false,
      requiredStatusChecks: requiredChecks.map((check) => check.context),
      mergeMethod,
      ruleset,
    },
    operations: [
      {
        method: existingRuleset ? "PUT" : "POST",
        endpoint: existingRuleset
          ? `repos/${normalizedRepository}/rulesets/${existingRuleset.id}`
          : `repos/${normalizedRepository}/rulesets`,
        body: ruleset,
      },
      {
        method: "PATCH",
        endpoint: `repos/${normalizedRepository}/branches/${encodeURIComponent(normalizedBranch)}/protection/required_status_checks`,
        body: { strict: false, checks: requiredChecks },
      },
    ],
  };
}

export async function reconcileDevMergeQueue({
  api,
  repository,
  branch,
  workflows,
  apply = false,
  bypassApps = [],
  bypassUsers = [],
  bypassTeams = [],
  checkResponseTimeoutMinutes = 120,
  maxEntriesToBuild = 1,
  bypassActors,
  queueParameters = {},
  allowInheritedWorkflowEvidence = false,
} = {}) {
  const encodedBranch = encodeURIComponent(requiredString(branch, "branch"));
  const repositorySettings = await api.request("GET", `repos/${repository}`);
  const protection = await api.request("GET", `repos/${repository}/branches/${encodedBranch}/protection`);
  const rulesets = await api.request("GET", `repos/${repository}/rulesets?includes_parents=false&per_page=100`);
  const resolvedBypassActors = bypassActors === undefined
    ? await resolveRulesetBypassActors({
        api,
        repository,
        apps: bypassApps,
        users: bypassUsers,
        teams: bypassTeams,
      })
    : normalizeRulesetBypassActors(bypassActors);
  const plan = createDevMergeQueuePlan({
    repository,
    branch,
    workflows,
    protection,
    repositorySettings,
    rulesets,
    bypassActors: resolvedBypassActors,
    checkResponseTimeoutMinutes,
    maxEntriesToBuild,
    queueParameters,
    allowInheritedWorkflowEvidence,
  });
  if (!apply) return { ...plan, action: "planned", applied: false };
  const results = [];
  for (const operation of plan.operations) {
    results.push(await api.request(operation.method, operation.endpoint, operation.body));
  }
  return {
    ...plan,
    action: plan.before.rulesetId ? "updated" : "created",
    applied: true,
    after: {
      strict: false,
      rulesetId: results[0]?.id || plan.before.rulesetId || null,
    },
  };
}

async function loadDetailedRulesets(api, repository) {
  const rulesets = await api.request("GET", `repos/${repository}/rulesets?includes_parents=false&per_page=100`);
  const details = [];
  for (const ruleset of Array.isArray(rulesets) ? rulesets : []) {
    if (ruleset?.target !== "branch" || ruleset?.enforcement === "disabled") continue;
    if (Array.isArray(ruleset.rules) && ruleset.conditions) {
      details.push(ruleset);
      continue;
    }
    details.push(await api.request("GET", `repos/${repository}/rulesets/${ruleset.id}`));
  }
  return details;
}

function findExactMergeQueueRuleset(rulesets, branch) {
  const include = `refs/heads/${branch}`;
  return rulesets.find((ruleset) =>
    ruleset?.enforcement === "active" &&
    ruleset?.conditions?.ref_name?.include?.length === 1 &&
    ruleset.conditions.ref_name.include[0] === include &&
    ruleset?.rules?.some((rule) => rule?.type === "merge_queue"),
  );
}

function mergeQueueRuleParameters(ruleset) {
  return ruleset?.rules?.find((rule) => rule?.type === "merge_queue")?.parameters || {};
}

export async function resolveConfiguredDevMergeQueuePolicy({
  api,
  repository,
  branch,
  cwd = process.cwd(),
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const declared = loadedConfig?.config?.governance?.dev?.mergeQueue;
  const policy = declared || {
    mode: "inherit",
    requiredWorkflows: [],
    checkResponseTimeoutMinutes: 120,
    maxEntriesToBuild: 1,
    bypassApps: [],
    bypassUsers: [],
    bypassTeams: [],
  };
  if (policy.mode === "disabled") {
    return {
      mode: "disabled",
      declared: Boolean(declared),
      enabled: false,
      reason: "merge queue policy is explicitly disabled",
      sourceBranch: null,
      sourceRulesetId: null,
      policy,
    };
  }

  if (policy.mode === "enabled") {
    return {
      mode: "enabled",
      declared: true,
      enabled: true,
      reason: "merge queue policy is explicitly enabled",
      sourceBranch: null,
      sourceRulesetId: null,
      policy,
      queueParameters: {},
      inheritedBypassActors: undefined,
    };
  }

  const repositorySettings = await api.request("GET", `repos/${repository}`);
  const sourceBranch = repositorySettings.default_branch;
  if (!sourceBranch || sourceBranch === branch) {
    const targetRuleset = findExactMergeQueueRuleset(await loadDetailedRulesets(api, repository), branch);
    if (!targetRuleset) {
      return {
        mode: "inherit",
        declared: Boolean(declared),
        enabled: false,
        reason: "the active dev branch has no exact merge queue ruleset",
        sourceBranch: sourceBranch || null,
        sourceRulesetId: null,
        policy,
      };
    }
    return {
      mode: "inherit",
      declared: Boolean(declared),
      enabled: true,
      reason: "the active dev branch merge queue policy is inherited",
      sourceBranch: branch,
      sourceRulesetId: targetRuleset.id,
      policy,
      queueParameters: mergeQueueRuleParameters(targetRuleset),
      inheritedBypassActors: targetRuleset.bypass_actors || [],
    };
  }
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(sourceBranch)) {
    return {
      mode: "inherit",
      declared: Boolean(declared),
      enabled: false,
      reason: `repository default branch '${sourceBranch}' is not a Buildchain dev channel`,
      sourceBranch,
      sourceRulesetId: null,
      policy,
    };
  }
  const sourceRuleset = findExactMergeQueueRuleset(await loadDetailedRulesets(api, repository), sourceBranch);
  return {
    mode: "inherit",
    declared: Boolean(declared),
    enabled: Boolean(sourceRuleset),
    reason: sourceRuleset
      ? "the active dev branch merge queue policy is inherited"
      : "the active dev branch has no exact merge queue ruleset",
    sourceBranch,
    sourceRulesetId: sourceRuleset?.id || null,
    policy,
    queueParameters: mergeQueueRuleParameters(sourceRuleset),
    inheritedBypassActors: sourceRuleset?.bypass_actors || [],
  };
}

export async function reconcileConfiguredDevMergeQueue({
  api,
  repository,
  branch,
  cwd = process.cwd(),
  apply = false,
} = {}) {
  const resolution = await resolveConfiguredDevMergeQueuePolicy({ api, repository, branch, cwd });
  if (!resolution.enabled) {
    return {
      schemaVersion: 1,
      contract: "kungfu-buildchain-dev-merge-queue-policy",
      repository,
      branch,
      ok: true,
      action: "not-required",
      applied: false,
      policyResolution: resolution,
      operations: [],
    };
  }
  const workflows = loadWorkflowSources(cwd, resolution.policy.requiredWorkflows);
  const result = await reconcileDevMergeQueue({
    api,
    repository,
    branch,
    workflows,
    apply,
    bypassApps: resolution.policy.bypassApps,
    bypassUsers: resolution.policy.bypassUsers,
    bypassTeams: resolution.policy.bypassTeams,
    bypassActors: resolution.mode === "inherit" ? resolution.inheritedBypassActors : undefined,
    checkResponseTimeoutMinutes: resolution.policy.checkResponseTimeoutMinutes,
    maxEntriesToBuild: resolution.policy.maxEntriesToBuild,
    queueParameters: resolution.mode === "inherit" ? resolution.queueParameters : {},
    allowInheritedWorkflowEvidence:
      resolution.mode === "inherit" && resolution.policy.requiredWorkflows.length === 0,
  });
  return { ...result, policyResolution: resolution };
}

function createGhApi() {
  return {
    request(method, endpoint, body) {
      const args = [
        "api",
        "--method",
        method,
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ];
      if (body !== undefined) args.push("--input", "-");
      const result = spawnSync("gh", args, {
        encoding: "utf8",
        input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
        env: process.env,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`GitHub API ${method} ${endpoint} failed: ${String(result.stderr || "").trim()}`);
      }
      const output = String(result.stdout || "").trim();
      return output ? JSON.parse(output) : {};
    },
  };
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function loadWorkflowSources(cwd, workflowPaths) {
  return workflowPaths.map((workflowPath) => {
    const absolutePath = path.resolve(cwd, workflowPath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`required workflow not found: ${workflowPath}`);
    }
    return { path: workflowPath, source: fs.readFileSync(absolutePath, "utf8") };
  });
}

async function main(args = process.argv.slice(2)) {
  const cwd = path.resolve(readFlag(args, "cwd", process.cwd()));
  const repository = readFlag(args, "repository", process.env.GITHUB_REPOSITORY || "");
  const branch = readFlag(args, "branch", "");
  if (args.includes("--from-config")) {
    const result = await reconcileConfiguredDevMergeQueue({
      api: createGhApi(),
      repository,
      branch,
      cwd,
      apply: args.includes("--apply"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const workflows = loadWorkflowSources(cwd, readRepeatedFlag(args, "workflow"));
  const result = await reconcileDevMergeQueue({
    api: createGhApi(),
    repository,
    branch,
    workflows,
    apply: args.includes("--apply"),
    checkResponseTimeoutMinutes: readFlag(args, "check-response-timeout-minutes", "120"),
    maxEntriesToBuild: readFlag(args, "max-entries-to-build", "1"),
    bypassApps: readRepeatedFlag(args, "bypass-app"),
    bypassUsers: readRepeatedFlag(args, "bypass-user"),
    bypassTeams: readRepeatedFlag(args, "bypass-team"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`buildchain dev merge-queue: ${error.message}`);
    process.exitCode = 1;
  });
}
