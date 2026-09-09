import { fileURLToPath } from "node:url";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { assertApply, readPlan, writeState } from "./line-open-workspace.mjs";

export function lineProtection(plan, channel) {
  requireValue(
    ["dev", "alpha", "release"].includes(channel),
    "Unknown release line channel",
  );
  const policy = plan.protection;
  return {
    required_status_checks: {
      strict: policy.strictStatusChecksByChannel[channel],
      checks: [
        ...new Set([
          policy.requiredStatusCheck,
          ...(channel === "alpha" ? ["verify"] : []),
        ]),
      ]
        .sort()
        .map((context) => ({ context, app_id: 15368 })),
    },
    enforce_admins: policy.enforceAdmins,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      required_approving_review_count: policy.requiredApprovingReviewCount,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      bypass_pull_request_allowances: {
        apps: ["github-actions"],
        users: [],
        teams: [],
      },
    },
    restrictions: null,
    required_conversation_resolution: policy.requiredConversationResolution,
  };
}
function repository(env) {
  assertApply(env);
  requireValue(
    Boolean(env.GH_TOKEN),
    "Release line governance requires BUILDCHAIN_PROMOTION_TOKEN",
  );
  requireValue(
    /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || ""),
    "Exact repository is required",
  );
  return env.GITHUB_REPOSITORY;
}
export function protectLine(env, execute = command) {
  const repo = repository(env);
  const plan = readPlan(env);
  for (const channel of ["dev", "alpha", "release"]) {
    execute(
      "gh",
      [
        "api",
        "--method",
        "PUT",
        `repos/${repo}/branches/${encodeURIComponent(plan.refs[channel])}/protection`,
        "--input",
        "-",
      ],
      {
        input: JSON.stringify(lineProtection(plan, channel)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}
export function reconcileLineQueue(env, execute = command) {
  const repo = repository(env);
  const plan = readPlan(env);
  const result = execute(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../dev-delivery/commands/dev-merge-queue.mjs",
          import.meta.url,
        ),
      ),
      "--cwd",
      ".",
      "--repository",
      repo,
      "--branch",
      plan.refs.dev,
      "--from-config",
      "--apply",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  writeState(env, "merge-queue", JSON.parse(result));
}
export function setLineDefault(env, execute = command) {
  const repo = repository(env);
  const plan = readPlan(env);
  requireValue(
    plan.repositoryActions.some(
      (action) => action.action === "set-default-branch",
    ),
    "Default branch switch was not planned",
  );
  execute("gh", ["repo", "edit", repo, "--default-branch", plan.refs.dev]);
}
export function openLineAlphaPr(env, execute = command) {
  const repo = repository(env);
  const plan = readPlan(env);
  requireValue(
    plan.repositoryActions.some((action) => action.action === "open-alpha-pr"),
    "Alpha PR was not planned",
  );
  const args = [
    "--repo",
    repo,
    "--base",
    plan.refs.alpha,
    "--head",
    plan.refs.dev,
  ];
  const existing = JSON.parse(
    execute(
      "gh",
      ["pr", "list", ...args, "--state", "open", "--json", "number"],
      { stdio: "pipe" },
    ),
  );
  requireValue(
    Array.isArray(existing) && existing.length <= 1,
    "Ambiguous existing alpha PR",
  );
  if (existing.length) return;
  execute("gh", [
    "pr",
    "create",
    ...args,
    "--title",
    `chore(release): promote ${plan.line} alpha`,
    "--body",
    `Buildchain release line bootstrap opened ${plan.line}. Merge this channel PR to publish the first alpha for the new minor line.`,
  ]);
}
