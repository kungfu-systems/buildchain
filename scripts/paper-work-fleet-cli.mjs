import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  PAPER_FLEET_AUDIT_CONTRACT,
  PAPER_FLEET_UPDATE_PLAN_CONTRACT,
  PAPER_MIGRATION_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
  PAPER_WORK_START_PLAN_CONTRACT,
  PAPER_WORK_SUBMIT_PLAN_CONTRACT,
  collectPaperFleetAudit,
  collectPaperStatus,
  createPaperWorkStartPlan,
  createPaperWorkSubmitPlan,
  discoverPaperFleet,
  executePaperWorkStart,
  executePaperWorkSubmitPush,
  planPaperMigration,
  planPaperScaffold,
  planPaperFleetUpdate,
  writePaperFleetUpdate,
  writePaperMigration,
  writePaperScaffold,
} from "../packages/core/paper.js";
import {
  BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY,
  compileEffectiveGithubGovernancePolicy,
} from "../packages/core/github-governance-authority.js";

function commandResult(command, args, { cwd, timeout = 60000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || "",
  };
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function githubPullRequests({ cwd, repository, branch }) {
  const query = commandResult(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,headRefName,baseRefName",
    ],
    { cwd },
  );
  if (!query.ok) {
    return {
      ok: false,
      rows: [],
      errorCode: query.error ? "gh-unavailable" : "github-pr-query-failed",
    };
  }
  try {
    const rows = JSON.parse(query.stdout || "[]");
    return {
      ok: Array.isArray(rows),
      rows: Array.isArray(rows) ? rows : [],
      errorCode: "",
    };
  } catch {
    return { ok: false, rows: [], errorCode: "github-pr-response-invalid" };
  }
}

function createPullRequest(plan, title, body) {
  const prTitle =
    title ||
    `chore(paper): ${plan.source.branch.replace(/^[^/]+\//, "").replaceAll("-", " ")}`;
  const prBody =
    body ||
    [
      "## Summary",
      "",
      "Submit this Paper work branch through the protected Buildchain development path.",
      "",
      "## Safety",
      "",
      "- No direct push to a protected channel.",
      "- No force push.",
      "- Publication remains behind the accepted PR and release gates.",
    ].join("\n");
  return commandResult(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      plan.repository,
      "--base",
      plan.target.branch,
      "--head",
      plan.source.branch,
      "--title",
      prTitle,
      "--body",
      prBody,
    ],
    { cwd: plan.cwd },
  );
}

function executeWorkSubmit(plan, args) {
  const pushed = executePaperWorkSubmitPush(plan);
  if (!pushed.ok) return pushed;
  if (plan.pullRequest?.url)
    return { ...pushed, reused: true, pr: plan.pullRequest };
  const created = createPullRequest(
    plan,
    readFlag(args, "title"),
    readFlag(args, "body"),
  );
  if (!created.ok) {
    return {
      ...pushed,
      ok: false,
      errorCode: created.error ? "gh-unavailable" : "github-pr-create-failed",
      stderr: created.error || created.stderr,
    };
  }
  const url =
    created.stdout
      .split(/\s+/)
      .find((entry) => /^https:\/\/github\.com\//.test(entry)) || "";
  return {
    ...pushed,
    reused: false,
    pr: {
      url,
      headRefName: plan.source.branch,
      baseRefName: plan.target.branch,
    },
  };
}

function compactRuleset(value) {
  return {
    id: value.id,
    name: value.name || "",
    enforcement: value.enforcement || "",
    target: value.target || "",
    bypass_actors: value.bypass_actors || [],
    conditions: value.conditions || {},
    rules: (value.rules || []).map((rule) => ({
      type: rule.type || "",
      parameters: rule.parameters || {},
    })),
  };
}

function fetchRulesets(cwd, repository) {
  const listed = commandResult(
    "gh",
    ["api", `repos/${repository}/rulesets?includes_parents=true`],
    { cwd },
  );
  if (!listed.ok) return { ok: false, rows: [] };
  try {
    const summaries = JSON.parse(listed.stdout || "[]");
    const rows = summaries.flatMap((summary) => {
      const detail = commandResult(
        "gh",
        ["api", `repos/${repository}/rulesets/${summary.id}`],
        { cwd },
      );
      if (!detail.ok) return [];
      try {
        return [compactRuleset(JSON.parse(detail.stdout || "{}"))];
      } catch {
        return [];
      }
    });
    return { ok: rows.length === summaries.length, rows };
  } catch {
    return { ok: false, rows: [] };
  }
}

function paperGovernanceTargetPolicies(repository) {
  const name = String(repository || "").split("/")[1] || "";
  return (
    BUILDCHAIN_GITHUB_GOVERNANCE_AUTHORITY.repositoryAdmission
      .publicAuthoritativeTargets[name] || []
  ).filter((entry) => /^(dev|alpha|release)\//.test(entry.targetRef));
}

function bindingKey(entry) {
  return `${entry.context}:${entry.appId ?? ""}`;
}

function sameBindings(observed, expected) {
  const left = (observed || []).map(bindingKey).sort();
  const right = (expected || []).map(bindingKey).sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function bypassAllowed(observed, allowed) {
  return (observed || []).every((actor) =>
    (allowed || []).some(
      (candidate) =>
        candidate.actorType === actor.actorType &&
        candidate.actorId === actor.actorId &&
        candidate.bypassMode === actor.bypassMode,
    ),
  );
}

export function evaluatePaperGithubGovernance({
  repository,
  actions = {},
  rulesets = [],
  protections = {},
} = {}) {
  const targetPolicies = paperGovernanceTargetPolicies(repository);
  const checks = [
    {
      id: "actions.default-workflow-permissions",
      ok: actions.default_workflow_permissions === "read",
    },
    {
      id: "actions.pull-request-approval-disabled",
      ok: actions.can_approve_pull_request_reviews === false,
    },
  ];
  const targets = targetPolicies.map((expected) => {
    const observation = protections[expected.targetRef] || {};
    const effective = compileEffectiveGithubGovernancePolicy({
      branch: expected.targetRef,
      defaultBranch: "",
      protectedBranch: observation.ok === true,
      protection: observation.protection || null,
      rulesets,
    });
    const targetChecks = [
      ["observed", observation.ok === true],
      ["native-pull-request", effective.nativePullRequestRequired === true],
      ["approving-review", Number(effective.requiredApprovals) >= 1],
      ["code-owner-review", effective.codeOwnerReviewRequired === true],
      [
        "fresh-review",
        effective.dismissStaleReviews === true ||
          effective.requireLastPushApproval === true,
      ],
      ["administrator-enforcement", effective.enforceAdmins === true],
      ["conversation-resolution", effective.conversationResolution === true],
      [
        "required-check-bindings",
        sameBindings(
          effective.requiredCheckBindings,
          expected.requiredCheckBindings,
        ),
      ],
      [
        "strict-required-checks",
        effective.strictRequiredChecks === expected.strictRequiredChecks,
      ],
      ["force-push-blocked", effective.allowForcePushes === false],
      ["deletion-blocked", effective.allowDeletions === false],
      [
        "bypass-policy",
        bypassAllowed(effective.bypassActors, expected.allowedBypassActors),
      ],
    ].map(([id, ok]) => ({
      id: `protection.${expected.targetRef}.${id}`,
      ok,
    }));
    checks.push(...targetChecks);
    return {
      targetRef: expected.targetRef,
      status: targetChecks.every((entry) => entry.ok) ? "pass" : "fail",
      effectivePolicy: effective,
    };
  });
  const normalizedChecks = checks.map((entry) => ({
    ...entry,
    status: entry.ok ? "pass" : "fail",
  }));
  return {
    status:
      targetPolicies.length > 0 && normalizedChecks.every((entry) => entry.ok)
        ? "pass"
        : "fail",
    checks: normalizedChecks,
    targets,
  };
}

function fetchProtection(cwd, repository, targetRef) {
  const result = commandResult(
    "gh",
    [
      "api",
      `repos/${repository}/branches/${encodeURIComponent(targetRef)}/protection`,
    ],
    { cwd },
  );
  if (!result.ok) return { ok: false, protection: null };
  try {
    return { ok: true, protection: JSON.parse(result.stdout || "{}") };
  } catch {
    return { ok: false, protection: null };
  }
}

function githubGovernance(cwd, repository) {
  const actions = commandResult(
    "gh",
    ["api", `repos/${repository}/actions/permissions/workflow`],
    { cwd },
  );
  const rulesets = fetchRulesets(cwd, repository);
  const targets = paperGovernanceTargetPolicies(repository);
  const protections = Object.fromEntries(
    targets.map((entry) => [
      entry.targetRef,
      fetchProtection(cwd, repository, entry.targetRef),
    ]),
  );
  if (!actions.ok || !rulesets.ok) {
    return {
      status: "fail",
      errorCode: actions.error
        ? "gh-unavailable"
        : "github-governance-query-failed",
      checks: [],
    };
  }
  try {
    const policy = JSON.parse(actions.stdout || "{}");
    const evaluation = evaluatePaperGithubGovernance({
      repository,
      actions: policy,
      rulesets: rulesets.rows,
      protections,
    });
    return {
      ...evaluation,
      errorCode: "",
      actions: policy,
      rulesets: rulesets.rows,
    };
  } catch {
    return {
      status: "fail",
      errorCode: "github-governance-response-invalid",
      checks: [],
    };
  }
}

function runWorkStart({ args, cwd }) {
  const topic = args[0]?.startsWith("--") ? "" : args[0] || "";
  const plan = createPaperWorkStartPlan({
    cwd,
    topic,
    branch: readFlag(args, "branch"),
  });
  return args.includes("--execute") ? executePaperWorkStart(plan) : plan;
}

function runScaffold(options) {
  const plan = planPaperScaffold({
    cwd: options.cwd,
    buildchainRoot: options.buildchainRoot,
    buildchainVersion: options.buildchainVersion,
    buildchainRef: readFlag(
      options.args,
      "buildchain-ref",
      options.buildchainRef,
    ),
    buildchainSha: options.buildchainSha,
    name: readFlag(options.args, "name", path.basename(options.cwd)),
    title: readFlag(options.args, "title"),
    packageName: readFlag(options.args, "package"),
    repository: readFlag(options.args, "repository"),
    version: readFlag(options.args, "version", "0.1.0-alpha.0"),
    siteBaseUrl: readFlag(options.args, "site-base-url"),
  });
  return options.args.some((entry) => ["--write", "--execute"].includes(entry))
    ? writePaperScaffold(plan)
    : plan;
}

function runMigration(options) {
  const plan = planPaperMigration({
    cwd: options.cwd,
    buildchainRoot: options.buildchainRoot,
    buildchainVersion: options.buildchainVersion,
    buildchainSha: options.buildchainSha,
  });
  return options.args.some((entry) => ["--write", "--execute"].includes(entry))
    ? writePaperMigration(plan)
    : plan;
}

function runWorkSubmit({ args, cwd }) {
  const repository = collectPaperStatus({ cwd }).identity.repository;
  const branch = commandResult("git", ["branch", "--show-current"], {
    cwd,
  }).stdout;
  const observation =
    repository && branch
      ? githubPullRequests({ cwd, repository, branch })
      : { ok: false, rows: [], errorCode: "paper-repository-unresolved" };
  const plan = createPaperWorkSubmitPlan({
    cwd,
    pullRequests: observation.rows,
    pullRequestObservation: observation,
  });
  return args.includes("--execute") ? executeWorkSubmit(plan, args) : plan;
}

function runFleetAudit(options) {
  const root = path.resolve(readFlag(options.args, "root", options.cwd));
  const repositories = discoverPaperFleet(root);
  const governance = {};
  if (!options.args.includes("--offline")) {
    for (const repositoryCwd of repositories) {
      const repository = collectPaperStatus({ cwd: repositoryCwd }).identity
        .repository;
      if (repository)
        governance[repository] = githubGovernance(repositoryCwd, repository);
    }
  }
  return collectPaperFleetAudit({
    ...options,
    root,
    repositories,
    governance,
    args: undefined,
    command: undefined,
    subcommand: undefined,
    cwd: undefined,
  });
}

function refreshFleetLocks(result) {
  for (const entry of result.results || []) {
    if (!entry.ok) continue;
    const lock = commandResult("pnpm", ["install", "--lockfile-only"], {
      cwd: entry.cwd,
    });
    if (lock.ok) continue;
    return {
      ...result,
      ok: false,
      errorCode: "paper-fleet-lock-refresh-failed",
      lockFailure: { cwd: entry.cwd, stderr: lock.error || lock.stderr },
    };
  }
  return result;
}

function runFleetUpdate(options) {
  const plan = planPaperFleetUpdate({
    root: path.resolve(readFlag(options.args, "root", options.cwd)),
    buildchainRoot: options.buildchainRoot,
    buildchainVersion: options.buildchainVersion,
    buildchainSha: options.buildchainSha,
  });
  return options.args.includes("--write")
    ? refreshFleetLocks(writePaperFleetUpdate(plan))
    : plan;
}

export function runPaperWorkFleetCli(options) {
  const route = `${options.command}:${options.subcommand}`;
  if (options.command === "scaffold")
    return { handled: true, result: runScaffold(options) };
  if (options.command === "migrate")
    return { handled: true, result: runMigration(options) };
  if (options.command === "status") {
    return { handled: true, result: collectPaperStatus({ cwd: options.cwd }) };
  }
  if (route === "work:start")
    return { handled: true, result: runWorkStart(options) };
  if (route === "work:submit")
    return { handled: true, result: runWorkSubmit(options) };
  if (route === "fleet:audit")
    return { handled: true, result: runFleetAudit(options) };
  if (route === "fleet:update")
    return { handled: true, result: runFleetUpdate(options) };
  return { handled: false, result: undefined };
}

export function printPaperWorkFleetSummary(result, fallback = () => {}) {
  if (
    [PAPER_SCAFFOLD_CONTRACT, PAPER_MIGRATION_CONTRACT].includes(
      result.contract,
    )
  )
    return false;
  if (result.contract === PAPER_WORK_START_PLAN_CONTRACT) {
    process.stdout.write(
      `paper work start: ${result.ok ? (result.dryRun ? "ready" : "created") : "blocked"}\n`,
    );
    process.stdout.write(
      `${result.source.developmentRef} -> ${result.target.branch || "<invalid>"}\n`,
    );
    for (const check of result.checks)
      process.stdout.write(
        `- ${check.status}: ${check.id}: ${check.message}\n`,
      );
    return true;
  }
  if (result.contract === PAPER_WORK_SUBMIT_PLAN_CONTRACT) {
    process.stdout.write(
      `paper work submit: ${result.ok ? (result.dryRun ? "ready" : result.pr?.url || "submitted") : "blocked"}\n`,
    );
    process.stdout.write(
      `${result.source.branch} -> ${result.target.branch}\n`,
    );
    for (const check of result.checks)
      process.stdout.write(
        `- ${check.status}: ${check.id}: ${check.message}\n`,
      );
    return true;
  }
  if (result.contract === PAPER_FLEET_AUDIT_CONTRACT) {
    process.stdout.write(
      `paper fleet audit: ${result.summary.current}/${result.summary.repositories} current\n`,
    );
    process.stdout.write(`audit root: ${result.auditRoot}\n`);
    for (const entry of result.repositories)
      process.stdout.write(
        `- ${entry.ok ? "current" : "drifted"}: ${entry.name}\n`,
      );
    return true;
  }
  if (result.contract === PAPER_FLEET_UPDATE_PLAN_CONTRACT) {
    process.stdout.write(
      `paper fleet update: ${result.ok ? (result.dryRun ? "ready" : "written") : "blocked"}\n`,
    );
    process.stdout.write(`plan root: ${result.planRoot}\n`);
    for (const entry of result.plans)
      process.stdout.write(
        `- ${entry.ok ? "ready" : "blocked"}: ${entry.cwd}\n`,
      );
    return true;
  }
  fallback(result);
  return false;
}
