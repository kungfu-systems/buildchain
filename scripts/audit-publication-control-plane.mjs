#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { evaluatePublicationControlPlaneSnapshot } from "../packages/core/publication-control-plane-audit.js";

function flag(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(process.argv[index + 1] || "");
}

function commandJson(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    const category = /401|E401|unauthorized/i.test(result.stderr) ? "unauthorized" : "unavailable";
    throw new Error(`${label} is ${category}; publication control-plane audit fails closed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return JSON; publication control-plane audit fails closed`);
  }
}

function githubJson(apiPath, label) {
  return commandJson("gh", ["api", apiPath, "-H", "Accept: application/vnd.github+json"], label);
}

function githubJsonOptional(apiPath, label, fallback) {
  const result = spawnSync("gh", ["api", apiPath, "-H", "Accept: application/vnd.github+json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    if (/404|not found/i.test(`${result.stdout}\n${result.stderr}`)) return fallback;
    const category = /401|403|unauthorized|forbidden/i.test(`${result.stdout}\n${result.stderr}`) ? "unauthorized" : "unavailable";
    throw new Error(`${label} is ${category}; publication control-plane audit fails closed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return JSON; publication control-plane audit fails closed`);
  }
}

function githubJsonReadLimited(apiPath, label, fallback) {
  const result = spawnSync("gh", ["api", apiPath, "-H", "Accept: application/vnd.github+json"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    if (/401|403|404|unauthorized|forbidden|not found/i.test(`${result.stdout}\n${result.stderr}`)) return fallback;
    throw new Error(`${label} is unavailable; publication control-plane audit fails closed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not return JSON; publication control-plane audit fails closed`);
  }
}

function rulesetIncludesBranch(ruleset, branch, defaultBranch) {
  const includes = ruleset.conditions?.ref_name?.include || [];
  const excludes = ruleset.conditions?.ref_name?.exclude || [];
  const ref = `refs/heads/${branch}`;
  const matches = (pattern) => (pattern === "~DEFAULT_BRANCH" && branch === defaultBranch) || pattern === branch || pattern === ref ||
    pattern === "refs/heads/*" || (pattern.endsWith("*") && ref.startsWith(pattern.slice(0, -1)));
  return includes.some(matches) && !excludes.some(matches);
}

function normalizeRulesetBranchPolicy(rulesets, branch, defaultBranch) {
  const applicable = rulesets.filter((ruleset) =>
    ruleset.enforcement === "active" && rulesetIncludesBranch(ruleset, branch, defaultBranch)
  );
  const rules = applicable.flatMap((ruleset) => ruleset.rules || []);
  const pullRequest = rules.find((rule) => rule.type === "pull_request")?.parameters || {};
  const requiredChecks = rules.find((rule) => rule.type === "required_status_checks")?.parameters || {};
  const adminBypass = applicable.some((ruleset) => (ruleset.bypass_actors || []).some((actor) =>
    actor.actor_type === "OrganizationAdmin" && actor.bypass_mode !== "pull_request"
  ));
  return {
    ref: branch,
    policyMode: "ruleset",
    strict: requiredChecks.strict_required_status_checks_policy === true,
    requiredApprovals: Number(pullRequest.required_approving_review_count || 0),
    requireConversationResolution: pullRequest.required_review_thread_resolution === true,
    enforceAdmins: !adminBypass,
    rulesetCount: applicable.length,
  };
}

function jobBlock(workflowText, jobId) {
  const lines = String(workflowText).split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) return "";
  const start = lines.findIndex((line, index) => index > jobsIndex && new RegExp(`^  ${jobId}:\\s*$`).test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function first(value, keys) {
  for (const key of keys) {
    const parts = key.split(".");
    let current = value;
    for (const part of parts) current = current && typeof current === "object" ? current[part] : undefined;
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return undefined;
}

function npmTrustEntries(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["relationships", "trustedPublishers", "trusted_publishers", "publishers", "items"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return value && typeof value === "object" ? Object.values(value).filter((entry) => entry && typeof entry === "object") : [];
}

function readSanitizedProviderAudit(filePath) {
  if (!filePath) throw new Error("--provider-audit-json is required for oidc-role publisher mode");
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  const forbidden = /^(?:policy|policyDocument|token|secret|credentials)$/i;
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, nested] of Object.entries(current)) {
      if (forbidden.test(key)) throw new Error(`provider audit must be sanitized; forbidden field: ${key}`);
      pending.push(nested);
    }
  }
  return value;
}

function readJsonValue(value, label) {
  if (!value) return null;
  try {
    return JSON.parse(fs.existsSync(value) ? fs.readFileSync(path.resolve(value), "utf8") : value);
  } catch {
    throw new Error(`${label} must be valid JSON or a path to a JSON file`);
  }
}

function normalizeNpmPublisher(value, { packageName, repository, workflowFilename, environment }) {
  const entries = npmTrustEntries(value);
  const normalized = entries.map((entry) => {
    const actions = first(entry, ["allowedActions", "allowed_actions", "permissions", "actions"]);
    const actionList = Array.isArray(actions) ? actions.map(String) : String(actions || "").split(/[\s,]+/).filter(Boolean);
    return {
      packageName: String(first(entry, ["packageName", "package", "package_name"]) || packageName),
      provider: String(first(entry, ["provider", "providerType", "provider.type", "type"]) || "").toLowerCase(),
      repository: String(first(entry, ["repository", "repo", "configuration.repository", "claims.repository"]) || ""),
      workflowFilename: String(first(entry, ["workflowFilename", "workflow_file", "file", "configuration.workflowFilename", "claims.workflow"]) || "").split("/").pop(),
      environment: String(first(entry, ["environment", "env", "configuration.environment", "claims.environment"]) || ""),
      allowPublish: actionList.some((action) => /^(?:npm[ _-]?)?publish$/i.test(action)) || first(entry, ["allowPublish", "allow_publish"]) === true,
      enforcement: "audited-control-plane",
      authorizationDeferred: false,
      configurationRead: true,
    };
  });
  return normalized.find((entry) =>
    entry.packageName === packageName &&
    /github/.test(entry.provider) &&
    entry.repository === repository &&
    entry.workflowFilename === workflowFilename &&
    entry.environment === environment
  ) || {
    packageName,
    provider: "",
    repository: "",
    workflowFilename: "",
    environment: "",
    allowPublish: false,
    enforcement: "audited-control-plane",
    authorizationDeferred: false,
    configurationRead: true,
  };
}

function main() {
  const repository = flag("repository");
  const workflowRepository = flag("workflow-repository", repository);
  const workflowPath = flag("workflow", ".github/workflows/release-candidate-promote.yml");
  const workflowRef = flag("workflow-ref");
  const publisherWorkflowPath = flag("publisher-workflow", workflowPath);
  const requiredStatusCheck = flag("required-status-check", "check");
  const jobId = flag("job", "promote");
  const environment = flag("environment", "none");
  const providerEnvironment = environment === "none" ? "" : environment;
  const branch = flag("branch");
  const sourceSha = flag("source-sha").toLowerCase();
  const packageName = flag("package", "@kungfu-tech/buildchain");
  const publisherMode = flag("publisher-mode", "npm-trusted-publisher");
  if (!repository || !branch) throw new Error("--repository and --branch are required");

  const encodedWorkflow = workflowPath.split("/").map(encodeURIComponent).join("/");
  const workflowFile = githubJson(
    `repos/${workflowRepository}/contents/${encodedWorkflow}${workflowRef ? `?ref=${encodeURIComponent(workflowRef)}` : ""}`,
    "publication workflow source",
  );
  const workflowText = Buffer.from(String(workflowFile.content || ""), "base64").toString("utf8");
  const block = jobBlock(workflowText, jobId);
  if (!block) throw new Error(`publication workflow job is missing: ${workflowPath}#${jobId}`);
  const jobsOffset = workflowText.search(/^jobs:\s*$/m);
  const workflowHeader = jobsOffset === -1 ? workflowText : workflowText.slice(0, jobsOffset);
  const explicitReadOnlyWorkflowPermissions = /^permissions:\s*\n(?:^[ \t]+[a-z-]+:\s*read\s*$\n?)+/m.test(workflowHeader) &&
    !/^\s*[a-z-]+:\s*write\s*$/m.test(workflowHeader) &&
    !/permissions\s*:\s*write-all/i.test(workflowHeader);

  const repositoryState = githubJson(`repos/${repository}`, "repository metadata");
  const branchState = githubJson(`repos/${repository}/branches/${encodeURIComponent(branch)}`, "branch summary");
  const exactTransactionSource = /^[0-9a-f]{40}$/.test(sourceSha);
  const protection = exactTransactionSource
    ? null
    : githubJsonReadLimited(`repos/${repository}/branches/${encodeURIComponent(branch)}/protection`, "branch protection", null);
  const rulesetList = githubJsonOptional(`repos/${repository}/rulesets?includes_parents=true&per_page=100`, "repository rulesets", []);
  const rulesets = [];
  for (const entry of Array.isArray(rulesetList) ? rulesetList : []) {
    if (!entry?.id) continue;
    rulesets.push(githubJson(`repos/${repository}/rulesets/${entry.id}`, `repository ruleset ${entry.id}`));
  }
  const environmentDeclared = /^ {4}environment\s*:/m.test(block);
  const environmentState = environment === "none"
    ? {}
    : githubJson(`repos/${repository}/environments/${encodeURIComponent(environment)}`, "publication Environment");
  const deploymentBranches = environment !== "none" && environmentState.deployment_branch_policy?.custom_branch_policies === true
    ? githubJson(`repos/${repository}/environments/${encodeURIComponent(environment)}/deployment-branch-policies?per_page=100`, "Environment deployment branch policy")
    : { branch_policies: [] };
  const oidc = githubJson(`repos/${repository}/actions/oidc/customization/sub`, "OIDC subject policy");
  if (!["npm-trusted-publisher", "github-token", "oidc-role"].includes(publisherMode)) {
    throw new Error(`unsupported --publisher-mode: ${publisherMode}`);
  }
  const longLivedWorkflowCredentialPresent = (
    /^\s*(?:NODE_AUTH_TOKEN|NPM_TOKEN|npm-token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s*:/im.test(block) ||
    /\$\{\{\s*secrets\.(?:NODE_AUTH_TOKEN|NPM_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\b/im.test(block)
  );
  const rulesetBranchPolicy = normalizeRulesetBranchPolicy(rulesets, branch, repositoryState.default_branch);
  let branchPolicy;
  if (protection) {
    branchPolicy = {
      ref: branch,
      policyMode: "branch-protection",
      strict: protection.required_status_checks?.strict === true,
      requiredApprovals: protection.required_pull_request_reviews?.required_approving_review_count || 0,
      requireConversationResolution: protection.required_conversation_resolution?.enabled === true,
      enforceAdmins: protection.enforce_admins?.enabled === true,
      observedRulesetCount: rulesets.length,
    };
  } else if (rulesetBranchPolicy.rulesetCount > 0) {
    branchPolicy = rulesetBranchPolicy;
  } else {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
      throw new Error("--source-sha is required when detailed branch policy is not readable");
    }
    const pullRequests = githubJson(`repos/${repository}/commits/${sourceSha}/pulls`, "source pull-request lineage");
    const mergedPullRequest = (Array.isArray(pullRequests) ? pullRequests : []).find((entry) =>
      entry?.merged_at &&
      entry.merge_commit_sha === sourceSha &&
      entry.base?.ref === branch &&
      entry.head?.repo?.full_name === repository
    );
    const reviews = mergedPullRequest
      ? githubJson(`repos/${repository}/pulls/${mergedPullRequest.number}/reviews?per_page=100`, "source pull-request reviews")
      : [];
    const latestReviews = new Map();
    for (const review of Array.isArray(reviews) ? reviews : []) {
      const login = String(review?.user?.login || "");
      if (login) latestReviews.set(login, review);
    }
    const independentApprovals = [...latestReviews.values()].filter((review) =>
      review.state === "APPROVED" && review.user?.login !== mergedPullRequest?.user?.login
    );
    const pullRequestHeadSha = String(mergedPullRequest?.head?.sha || "").toLowerCase();
    const checkRuns = /^[0-9a-f]{40}$/.test(pullRequestHeadSha)
      ? githubJson(`repos/${repository}/commits/${pullRequestHeadSha}/check-runs?per_page=100`, "merged pull-request head check runs")
      : { check_runs: [] };
    const requiredStatusCheckPolicy = branchState.protection?.required_status_checks || {};
    const requiredStatusChecks = [...new Set([
      ...(requiredStatusCheckPolicy.contexts || []),
      ...(requiredStatusCheckPolicy.checks || []).map((entry) => entry.context),
    ].filter(Boolean))];
    const exactRequiredStatusCheck = requiredStatusChecks.includes(requiredStatusCheck)
      ? requiredStatusCheck
      : "";
    const prefixedRequiredStatusChecks = requiredStatusChecks.filter((context) =>
      context.startsWith(`${requiredStatusCheck} / `)
    );
    const resolvedRequiredStatusCheck = exactRequiredStatusCheck ||
      (prefixedRequiredStatusChecks.length === 1 ? prefixedRequiredStatusChecks[0] : requiredStatusCheck);
    const requiredStatusCheckMatchCount = exactRequiredStatusCheck ? 1 : prefixedRequiredStatusChecks.length;
    const requiredCheckSource = (requiredStatusCheckPolicy.checks || []).find((entry) =>
      entry.context === resolvedRequiredStatusCheck
    );
    branchPolicy = {
      ref: branch,
      policyMode: "provider-enforced-transaction",
      protected: branchState.protected === true,
      enforcementLevel: branchState.protection?.required_status_checks?.enforcement_level || "",
      requiredStatusChecks,
      declaredRequiredStatusCheck: requiredStatusCheck,
      requiredStatusCheck: resolvedRequiredStatusCheck,
      requiredStatusCheckMatchCount,
      requiredCheckPassed: (checkRuns.check_runs || []).some((entry) =>
        entry.name === resolvedRequiredStatusCheck &&
        entry.conclusion === "success" &&
        (!requiredCheckSource?.app_id || entry.app?.id === requiredCheckSource.app_id)
      ),
      requiredCheckAppId: requiredCheckSource?.app_id || 0,
      requiredCheckSha: pullRequestHeadSha,
      sourceSha,
      headSha: String(branchState.commit?.sha || "").toLowerCase(),
      mergedPullRequest: Boolean(mergedPullRequest),
      pullRequestNumber: mergedPullRequest?.number || 0,
      pullRequestHeadSha,
      baseRef: mergedPullRequest?.base?.ref || "",
      headRepository: mergedPullRequest?.head?.repo?.full_name || "",
      approvalCount: independentApprovals.length,
      independentApproval: independentApprovals.length > 0,
      configurationRead: false,
      evidenceSource: "public-provider-transaction",
    };
  }
  let publisher;
  if (publisherMode === "npm-trusted-publisher") {
    const trust = readJsonValue(flag("npm-trust-json"), "--npm-trust-json");
    publisher = trust
      ? normalizeNpmPublisher(trust, {
        packageName,
        repository,
        workflowFilename: path.basename(publisherWorkflowPath),
        environment: providerEnvironment,
      })
      : {
        packageName,
        provider: "github",
        repository,
        workflowFilename: path.basename(publisherWorkflowPath),
        environment: providerEnvironment,
        allowPublish: false,
        enforcement: "provider-at-transaction",
        authorizationDeferred: true,
        configurationRead: false,
      };
  } else if (publisherMode === "github-token") {
    publisher = {
      provider: "github-token",
      repository,
      workflowPath,
      permissionScoped: /^\s{6}contents:\s*write\s*$/m.test(block) && !/^\s{2}contents:\s*write\s*$/m.test(workflowText),
    };
  } else {
    publisher = readSanitizedProviderAudit(flag("provider-audit-json"));
  }
  publisher.longLivedWorkflowCredentialPresent = longLivedWorkflowCredentialPresent;

  const reviewRules = (environmentState.protection_rules || []).filter((rule) => rule.type === "required_reviewers");
  const runsOn = (block.match(/^\s{4}runs-on:\s*([^\n#]+)/m)?.[1] || "").trim().replace(/["']/g, "");
  const observedAt = new Date();
  const expiresAt = new Date(observedAt.getTime() + 10 * 60 * 1000);
  const receipt = evaluatePublicationControlPlaneSnapshot({
    repository,
    workflowPath,
    publisherWorkflowPath,
    environment,
    branch,
    packageName,
    publisherMode,
    requiredStatusCheck,
    observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    snapshot: {
      actions: {
        defaultWorkflowPermissions: explicitReadOnlyWorkflowPermissions ? "read" : "unqualified",
        canApprovePullRequestReviews: false,
        evidenceSource: "exact-workflow-source",
      },
      branch: branchPolicy,
      environment: {
        name: environment === "none" ? "none" : environmentState.name || environment,
        declared: environmentDeclared,
        exists: Boolean(environmentState.id || environmentState.node_id),
        protected: (environmentState.protection_rules || []).length > 0 ||
          environmentState.deployment_branch_policy?.protected_branches === true ||
          (deploymentBranches.branch_policies || []).length > 0,
        reviewRequired: reviewRules.length > 0,
        preventSelfReview: reviewRules.some((rule) => rule.prevent_self_review === true),
      },
      oidc: {
        workflowPath: publisherWorkflowPath,
        environment: providerEnvironment,
        idTokenJobScoped: /^\s{6}id-token:\s*write\s*$/m.test(block) && !/^\s{2}id-token:\s*write\s*$/m.test(workflowText),
        githubTokenJobScoped: /^\s{6}contents:\s*write\s*$/m.test(block) && !/^\s{2}contents:\s*write\s*$/m.test(workflowText),
        longLivedCredentialPresent: publisher.longLivedWorkflowCredentialPresent,
        useDefaultSubject: oidc.use_default === true,
        includedClaims: oidc.include_claim_keys || [],
      },
      publisher,
      runner: {
        class: runsOn === "ubuntu-24.04" ? "ephemeral" : "unqualified",
        label: runsOn,
        githubHosted: runsOn === "ubuntu-24.04",
        selfHostedAuthorized: /self-hosted/i.test(runsOn),
        evidenceSource: "exact-workflow-job",
      },
    },
  });
  const output = flag("output");
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (output) fs.writeFileSync(path.resolve(output), serialized);
  else process.stdout.write(serialized);
  const failed = receipt.facts.filter((entry) => entry.status !== "pass").map((entry) => entry.id);
  if (failed.length && !process.argv.includes("--allow-nonqualifying")) {
    throw new Error(`publication control-plane audit is non-qualifying: ${failed.join(", ")}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`publication control-plane audit: ${error.message}`);
  process.exitCode = 1;
}
