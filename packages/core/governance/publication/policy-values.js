import fs from "node:fs";
import path from "node:path";
function rulesetIncludesBranch(ruleset, branch, defaultBranch) {
  const includes = ruleset.conditions?.ref_name?.include || [];
  const excludes = ruleset.conditions?.ref_name?.exclude || [];
  const ref = `refs/heads/${branch}`;
  const matches = (pattern) =>
    (pattern === "~DEFAULT_BRANCH" && branch === defaultBranch) ||
    pattern === branch ||
    pattern === ref ||
    pattern === "refs/heads/*" ||
    (pattern.endsWith("*") && ref.startsWith(pattern.slice(0, -1)));
  return includes.some(matches) && !excludes.some(matches);
}

export function normalizeRulesetBranchPolicy(rulesets, branch, defaultBranch) {
  const applicable = rulesets.filter(
    (ruleset) =>
      ruleset.enforcement === "active" &&
      rulesetIncludesBranch(ruleset, branch, defaultBranch),
  );
  const rules = applicable.flatMap((ruleset) => ruleset.rules || []);
  const pullRequest =
    rules.find((rule) => rule.type === "pull_request")?.parameters || {};
  const requiredChecks =
    rules.find((rule) => rule.type === "required_status_checks")?.parameters ||
    {};
  const adminBypass = applicable.some((ruleset) =>
    (ruleset.bypass_actors || []).some(
      (actor) =>
        actor.actor_type === "OrganizationAdmin" &&
        actor.bypass_mode !== "pull_request",
    ),
  );
  return {
    ref: branch,
    policyMode: "ruleset",
    strict: requiredChecks.strict_required_status_checks_policy === true,
    requiredApprovals: Number(pullRequest.required_approving_review_count || 0),
    requireConversationResolution:
      pullRequest.required_review_thread_resolution === true,
    enforceAdmins: !adminBypass,
    rulesetCount: applicable.length,
  };
}

export function jobBlock(workflowText, jobId, delegated = false) {
  const lines = String(workflowText).split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) return "";
  const start = lines.findIndex(
    (line, index) =>
      index > jobsIndex && new RegExp(`^  ${jobId}:\\s*$`).test(line),
  );
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const block = lines.slice(start, end).join("\n");
  if (delegated) return block;
  const declarations = [
    ...block.matchAll(
      /^ {4}# buildchain-publication-authority-job:\s*([A-Za-z0-9_-]+)\s*$/gm,
    ),
  ];
  if (declarations.length > 1 || declarations[0]?.[1] === jobId)
    throw new Error(
      `publication authority job delegation is invalid: ${jobId}`,
    );
  if (!declarations.length) return block;
  const delegatedJobId = declarations[0][1];
  const delegatedBlock = jobBlock(workflowText, delegatedJobId, true);
  if (!delegatedBlock)
    throw new Error(
      `delegated publication workflow job is missing: ${delegatedJobId}`,
    );
  return delegatedBlock;
}

function first(value, keys) {
  for (const key of keys) {
    let current = value;
    for (const part of key.split("."))
      current =
        current && typeof current === "object" ? current[part] : undefined;
    if (current !== undefined && current !== null && current !== "")
      return current;
  }
  return undefined;
}

function npmTrustEntries(value) {
  if (Array.isArray(value)) return value;
  for (const key of [
    "relationships",
    "trustedPublishers",
    "trusted_publishers",
    "publishers",
    "items",
  ]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return value && typeof value === "object"
    ? Object.values(value).filter((entry) => entry && typeof entry === "object")
    : [];
}

export function readSanitizedProviderAudit(filePath) {
  if (!filePath)
    throw new Error(
      "--provider-audit-json is required for oidc-role publisher mode",
    );
  const value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  const forbidden = /^(?:policy|policyDocument|token|secret|credentials)$/i;
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, nested] of Object.entries(current)) {
      if (forbidden.test(key))
        throw new Error(
          `provider audit must be sanitized; forbidden field: ${key}`,
        );
      pending.push(nested);
    }
  }
  return value;
}

export function readJsonValue(value, label) {
  if (!value) return null;
  try {
    return JSON.parse(
      fs.existsSync(value)
        ? fs.readFileSync(path.resolve(value), "utf8")
        : value,
    );
  } catch {
    throw new Error(`${label} must be valid JSON or a path to a JSON file`);
  }
}

export function normalizeNpmPublisher(
  value,
  { packageName, repository, workflowFilename, environment },
) {
  const entries = npmTrustEntries(value);
  const normalized = entries.map((entry) => {
    const actions = first(entry, [
      "allowedActions",
      "allowed_actions",
      "permissions",
      "actions",
    ]);
    const actionList = Array.isArray(actions)
      ? actions.map(String)
      : String(actions || "")
          .split(/[\s,]+/)
          .filter(Boolean);
    return {
      packageName: String(
        first(entry, ["packageName", "package", "package_name"]) || packageName,
      ),
      provider: String(
        first(entry, ["provider", "providerType", "provider.type", "type"]) ||
          "",
      ).toLowerCase(),
      repository: String(
        first(entry, [
          "repository",
          "repo",
          "configuration.repository",
          "claims.repository",
        ]) || "",
      ),
      workflowFilename: String(
        first(entry, [
          "workflowFilename",
          "workflow_file",
          "file",
          "configuration.workflowFilename",
          "claims.workflow",
        ]) || "",
      )
        .split("/")
        .pop(),
      environment: String(
        first(entry, [
          "environment",
          "env",
          "configuration.environment",
          "claims.environment",
        ]) || "",
      ),
      allowPublish:
        actionList.some((action) => /^(?:npm[ _-]?)?publish$/i.test(action)) ||
        first(entry, ["allowPublish", "allow_publish"]) === true,
      enforcement: "audited-control-plane",
      authorizationDeferred: false,
      configurationRead: true,
    };
  });
  return (
    normalized.find(
      (entry) =>
        entry.packageName === packageName &&
        /github/.test(entry.provider) &&
        entry.repository === repository &&
        entry.workflowFilename === workflowFilename &&
        entry.environment === environment,
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
    }
  );
}
