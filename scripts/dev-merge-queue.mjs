import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
} = {}) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedBranch = requiredString(branch, "branch");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalizedBranch)) {
    throw new Error(`branch must be a Buildchain dev channel, got '${normalizedBranch}'`);
  }
  const workflowChecks = validateMergeGroupWorkflows(workflows);
  const mergeMethod = selectMergeQueueMethod(repositorySettings);
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
        check_response_timeout_minutes: positiveInteger(checkResponseTimeoutMinutes, "check response timeout", 120),
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: positiveInteger(maxEntriesToBuild, "max entries to build", 1),
        max_entries_to_merge: 1,
        merge_method: mergeMethod,
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 0,
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
} = {}) {
  const encodedBranch = encodeURIComponent(requiredString(branch, "branch"));
  const repositorySettings = await api.request("GET", `repos/${repository}`);
  const protection = await api.request("GET", `repos/${repository}/branches/${encodedBranch}/protection`);
  const rulesets = await api.request("GET", `repos/${repository}/rulesets?includes_parents=false&per_page=100`);
  const bypassActors = await resolveRulesetBypassActors({
    api,
    repository,
    apps: bypassApps,
    users: bypassUsers,
    teams: bypassTeams,
  });
  const plan = createDevMergeQueuePlan({
    repository,
    branch,
    workflows,
    protection,
    repositorySettings,
    rulesets,
    bypassActors,
    checkResponseTimeoutMinutes,
    maxEntriesToBuild,
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
