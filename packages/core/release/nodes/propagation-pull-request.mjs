import { exactRemoteBranch } from "../../providers/git-ref-readback.mjs";
import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import {
  executeReleasePropagationPush,
  verifyReleasePropagationWork,
} from "../release-propagation.js";
import {
  propagationPaths,
  request,
  readPropagation,
  writePropagation,
} from "./propagation-io.mjs";
import { recordPropagationStage } from "./propagation-work.mjs";

export function preparePropagationOutcome(env) {
  writePropagation(
    "pr-outcome.json",
    {
      state: "planned",
      number: null,
      url: "",
      branch: JSON.parse(env.BUILDCHAIN_PROPAGATION_PLAN_JSON).branch,
    },
    env,
  );
}
export function uniquePropagationPr(rows) {
  requireValue(
    Array.isArray(rows) && rows.length <= 1,
    "Release propagation found duplicate matching PRs",
  );
  if (rows.length)
    requireValue(
      Number.isInteger(rows[0].number) &&
        rows[0].number > 0 &&
        /^https:\/\//.test(rows[0].url),
      "Propagation PR lookup returned invalid coordinates",
    );
  return rows[0] || null;
}
export function openPropagationPr(
  env,
  {
    execute = command,
    push = executeReleasePropagationPush,
    record = recordPropagationStage,
  } = {},
) {
  const input = request(env),
    { downstream, root } = propagationPaths(env);
  const work = readPropagation("work.json", env);
  const status = verifyReleasePropagationWork(work);
  requireValue(
    work.authority.mode === "execute" &&
      status.lifecycle === "ready" &&
      status.currentStage === "push-branch",
    "Propagation Work is not ready for the push stage",
  );
  requireValue(
    input["dry-run"] === false,
    "Dry-run propagation cannot push or open a PR",
  );
  const repository = work.downstream.repository,
    branch = work.downstream.branch,
    base = work.downstream.baseRef;
  const git = (args, pipe = false) =>
    execute("git", args, { cwd: downstream, stdio: pipe ? "pipe" : "inherit" });
  const gh = (args) =>
    execute("gh", args, { cwd: downstream, stdio: "pipe" }).trim();
  requireValue(
    git(["branch", "--show-current"], true).trim() === branch,
    "Current branch does not match propagation Work",
  );
  const existing = uniquePropagationPr(
    JSON.parse(
      gh([
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--base",
        base,
        "--head",
        branch,
        "--json",
        "number,url",
      ]),
    ),
  );
  const remoteSha = exactRemoteBranch(branch, execute, downstream);
  git(["add", "--all"]);
  const changed = Boolean(git(["diff", "--cached", "--name-only", "-z"], true));
  if (changed)
    git([
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--signoff",
      "-m",
      input["pr-title"],
    ]);
  let pushedSha = git(["rev-parse", "HEAD"], true).trim(),
    pushResult;
  if (changed || remoteSha) {
    pushResult = push({
      work,
      expectedWorkRoot: work.contentRoot,
      cwd: downstream,
    });
    pushedSha = pushResult.evidence.revision;
    writePropagation("push-result.json", pushResult, env);
    record(env, "push-branch", [pushResult.evidence]);
  }
  const bodyPath = path.join(root, "pr-body.md");
  fs.writeFileSync(
    bodyPath,
    `${input["pr-body"] || ""}\n\nBuildchain release propagation plan:\n\n\`\`\`json\n${JSON.stringify(readPropagation("plan.json", env), null, 2)}\n\`\`\`\n`,
  );
  let result = { state: "no-change", number: null, url: "", branch };
  if (existing) {
    gh([
      "pr",
      "edit",
      String(existing.number),
      "--repo",
      repository,
      "--title",
      input["pr-title"],
      "--body-file",
      bodyPath,
    ]);
    result = {
      state: changed ? "updated" : "reused",
      number: existing.number,
      url: existing.url,
      branch,
    };
  } else if (changed) {
    const url = gh([
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      base,
      "--head",
      branch,
      "--title",
      input["pr-title"],
      "--body-file",
      bodyPath,
    ]);
    const pr = JSON.parse(
      gh([
        "pr",
        "view",
        url,
        "--repo",
        repository,
        "--json",
        "number,url,baseRefName,headRefName,headRefOid",
      ]),
    );
    requireValue(
      pr.baseRefName === base &&
        pr.headRefName === branch &&
        pr.headRefOid === pushedSha,
      "Created PR readback does not match the exact pushed branch",
    );
    uniquePropagationPr([pr]);
    result = { state: "created", number: pr.number, url: pr.url, branch };
  }
  writePropagation("pr-outcome.json", result, env);
  writePropagation(
    "branch-reconciliation.json",
    {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-propagation-branch-reconciliation",
      repository,
      branch,
      base,
      action: pushResult?.mutation ? "fast-forward-push" : "no-lock-change",
      observedRemoteSha: remoteSha,
      pushedSha,
      leaseMode: pushResult ? "fast-forward-only-exact-refspec" : "none",
      pullRequestAction: result.state,
      pullRequest: result,
    },
    env,
  );
  return result;
}
