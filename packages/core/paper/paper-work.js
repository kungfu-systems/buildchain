import path from "node:path";
import { collectPaperAgentEntry } from "./paper-agent-entry.js";
import {
  PAPER_PATHS,
  PAPER_WORK_BRANCH_PATTERN,
  gitResult,
  gitValue,
  normalizedWorkBranch,
  paperDevelopmentRef,
  paperWorkSource,
  readJson,
  remoteBranchObservation,
  rootedPlan,
  workCheck,
} from "./paper-repository.js";

export const PAPER_WORK_START_PLAN_CONTRACT =
  "kungfu-buildchain-paper-work-start-plan";
export const PAPER_WORK_SUBMIT_PLAN_CONTRACT =
  "kungfu-buildchain-paper-work-submit-plan";

function failedActions(checks) {
  return checks
    .filter((entry) => entry.status === "fail")
    .map((entry) => ({
      id: `repair-${entry.id}`,
      command: entry.correctiveCommand,
      description: entry.message,
    }));
}

function agentEntryForWork(cwd, buildchainSha) {
  const policy = readJson(path.resolve(cwd, PAPER_PATHS.agentEntry)).value;
  return collectPaperAgentEntry({
    cwd,
    buildchainSha: buildchainSha || policy?.runtime?.sourceSha || "",
    mode: "contract",
  });
}

export function createPaperWorkStartPlan({
  cwd = process.cwd(),
  topic = "",
  branch = "",
  buildchainSha = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const source = paperWorkSource(resolvedCwd);
  const targetBranch = normalizedWorkBranch(topic, branch);
  const developmentRef = paperDevelopmentRef(resolvedCwd);
  const remoteDevelopment = remoteBranchObservation(
    resolvedCwd,
    developmentRef,
  );
  const remoteTarget = targetBranch
    ? remoteBranchObservation(resolvedCwd, targetBranch)
    : { observed: false, sha: "" };
  const localTarget = targetBranch
    ? gitValue(resolvedCwd, [
        "rev-parse",
        "--verify",
        `refs/heads/${targetBranch}`,
      ])
    : "";
  const remoteCommitPresent = remoteDevelopment.sha
    ? gitResult(resolvedCwd, [
        "cat-file",
        "-e",
        `${remoteDevelopment.sha}^{commit}`,
      ]).ok
    : false;
  const agentEntry = agentEntryForWork(resolvedCwd, buildchainSha);
  const checks = [
    workCheck(
      "agent-entry.current",
      agentEntry.ok,
      "The mandatory Buildchain Paper agent-entry contract is current.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "repository.canonical-origin",
      source.canonical,
      "The paper repository has exactly one canonical kungfu-systems origin.",
      "git remote -v",
    ),
    workCheck(
      "source.clean",
      source.clean,
      "The worktree is clean.",
      "git status --short",
    ),
    workCheck(
      "source.development-ref",
      source.branch === developmentRef,
      `The current branch is the configured development ref ${developmentRef}.`,
      `git switch ${developmentRef}`,
    ),
    workCheck(
      "remote.development-ref",
      remoteDevelopment.ok,
      `origin/${developmentRef} resolves to an exact commit.`,
      `git fetch origin ${developmentRef}`,
    ),
    workCheck(
      "source.remote-aligned",
      Boolean(remoteDevelopment.sha) && source.head === remoteDevelopment.sha,
      "HEAD equals the exact remote development commit.",
      `git fetch origin ${developmentRef} && git merge --ff-only origin/${developmentRef}`,
    ),
    workCheck(
      "source.remote-commit-present",
      remoteCommitPresent,
      "The exact remote development commit is present locally.",
      `git fetch origin ${developmentRef}`,
    ),
    workCheck(
      "target.safe-name",
      Boolean(targetBranch),
      "The work branch uses an allowed non-protected prefix and safe slug.",
      "use feature|fix|docs|chore|ci|refactor/<slug>",
    ),
    workCheck(
      "target.absent",
      Boolean(targetBranch) &&
        remoteTarget.observed &&
        !localTarget &&
        !remoteTarget.sha,
      "The work branch does not already exist locally or remotely.",
      "choose a fresh work branch name",
    ),
  ];
  const ok = checks.every((entry) => entry.status === "pass");
  return rootedPlan({
    schemaVersion: 1,
    contract: PAPER_WORK_START_PLAN_CONTRACT,
    ok,
    cwd: resolvedCwd,
    dryRun: true,
    source: {
      ...source,
      developmentRef,
      remoteDevelopmentSha: remoteDevelopment.sha,
    },
    runtime: {
      sourceSha: buildchainSha || agentEntry.entry?.runtime?.sourceSha || "",
    },
    target: { branch: targetBranch, startSha: remoteDevelopment.sha },
    checks,
    mutation: {
      kind: "local-branch-create",
      force: false,
      command: targetBranch
        ? `git switch -c ${targetBranch} ${remoteDevelopment.sha || `<origin/${developmentRef}>`}`
        : "",
    },
    nextActions: ok
      ? [
          {
            id: "create-work-branch",
            command: `buildchain paper work start ${targetBranch} --branch ${targetBranch} --execute --json`,
            description:
              "Create the local work branch from the exact observed remote development commit.",
          },
        ]
      : failedActions(checks),
  });
}

export function executePaperWorkStart(plan) {
  if (!plan || plan.contract !== PAPER_WORK_START_PLAN_CONTRACT || !plan.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      errorCode: "paper-work-start-blocked",
    };
  }
  const fresh = createPaperWorkStartPlan({
    cwd: plan.cwd,
    branch: plan.target.branch,
    buildchainSha: plan.runtime?.sourceSha || "",
  });
  if (!fresh.ok || fresh.planRoot !== plan.planRoot) {
    return {
      ...fresh,
      ok: false,
      dryRun: false,
      errorCode: "paper-work-start-race",
    };
  }
  const switched = gitResult(plan.cwd, [
    "switch",
    "-c",
    plan.target.branch,
    plan.target.startSha,
  ]);
  return {
    ...fresh,
    ok: switched.ok,
    dryRun: false,
    created: switched.ok,
    errorCode: switched.ok ? "" : "paper-work-branch-create-failed",
    stderr: switched.ok ? "" : switched.error || switched.stderr,
  };
}

export function createPaperWorkSubmitPlan({
  cwd = process.cwd(),
  pullRequests = [],
  pullRequestObservation = { ok: true },
  buildchainSha = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const source = paperWorkSource(resolvedCwd);
  const developmentRef = paperDevelopmentRef(resolvedCwd);
  const remoteDevelopment = remoteBranchObservation(
    resolvedCwd,
    developmentRef,
  );
  const remoteWork = source.branch
    ? remoteBranchObservation(resolvedCwd, source.branch)
    : { observed: false, sha: "" };
  const developmentAncestor =
    Boolean(remoteDevelopment.sha) &&
    gitResult(resolvedCwd, [
      "merge-base",
      "--is-ancestor",
      remoteDevelopment.sha,
      source.head,
    ]).ok;
  const remoteWorkAncestor =
    remoteWork.observed &&
    (!remoteWork.sha ||
      gitResult(resolvedCwd, [
        "merge-base",
        "--is-ancestor",
        remoteWork.sha,
        source.head,
      ]).ok);
  const wrongBasePullRequests = pullRequests.filter(
    (entry) =>
      entry.headRefName === source.branch &&
      entry.baseRefName !== developmentRef,
  );
  const matchingPullRequest = pullRequests.find(
    (entry) =>
      entry.headRefName === source.branch &&
      entry.baseRefName === developmentRef,
  );
  const agentEntry = agentEntryForWork(resolvedCwd, buildchainSha);
  const checks = [
    workCheck(
      "agent-entry.current",
      agentEntry.ok,
      "The mandatory Buildchain Paper agent-entry contract is current.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "repository.canonical-origin",
      source.canonical,
      "The paper repository has exactly one canonical kungfu-systems origin.",
      "git remote -v",
    ),
    workCheck(
      "source.clean",
      source.clean,
      "The worktree is clean.",
      "git status --short",
    ),
    workCheck(
      "source.safe-work-branch",
      PAPER_WORK_BRANCH_PATTERN.test(source.branch),
      "The current branch is an allowed non-protected work branch.",
      "buildchain paper work start <topic>",
    ),
    workCheck(
      "source.committed",
      /^[0-9a-f]{40}$/i.test(source.head),
      "The submitted source resolves to an exact commit.",
      "git status --short",
    ),
    workCheck(
      "remote.development-ref",
      remoteDevelopment.ok,
      `origin/${developmentRef} resolves to an exact commit.`,
      `git fetch origin ${developmentRef}`,
    ),
    workCheck(
      "source.contains-development",
      developmentAncestor,
      "The work branch contains the exact remote development commit.",
      `git fetch origin ${developmentRef} && git rebase origin/${developmentRef}`,
    ),
    workCheck(
      "remote.work-fast-forward",
      remoteWorkAncestor,
      "The remote work branch is absent or can be advanced without force.",
      `git fetch origin ${source.branch}`,
    ),
    workCheck(
      "pull-request.target",
      wrongBasePullRequests.length === 0,
      `No open pull request targets a branch other than ${developmentRef}.`,
      "close or retarget the conflicting pull request",
    ),
    workCheck(
      "pull-request.observed",
      pullRequestObservation.ok === true,
      "Open pull requests for the source branch were observed successfully.",
      "gh auth status",
    ),
  ];
  const ok = checks.every((entry) => entry.status === "pass");
  return rootedPlan({
    schemaVersion: 1,
    contract: PAPER_WORK_SUBMIT_PLAN_CONTRACT,
    ok,
    cwd: resolvedCwd,
    dryRun: true,
    repository: source.repository,
    source: {
      branch: source.branch,
      sha: source.head,
      remoteSha: remoteWork.sha,
    },
    target: { branch: developmentRef, sha: remoteDevelopment.sha },
    runtime: {
      sourceSha: buildchainSha || agentEntry.entry?.runtime?.sourceSha || "",
    },
    pullRequest: matchingPullRequest || null,
    checks,
    mutation: {
      kind: "normal-push-and-pull-request",
      force: false,
      pushCommand: `git push --set-upstream origin HEAD:refs/heads/${source.branch}`,
      pullRequestCommand: matchingPullRequest
        ? ""
        : `gh pr create --repo ${source.repository} --base ${developmentRef} --head ${source.branch}`,
    },
    nextActions: ok
      ? [
          {
            id: matchingPullRequest ? "reuse-pull-request" : "submit-work",
            command: matchingPullRequest
              ? ""
              : "buildchain paper work submit --execute --json",
            description: matchingPullRequest
              ? "Continue the existing correctly targeted pull request."
              : "Push without force and open a pull request to the configured development ref.",
            url: matchingPullRequest?.url || "",
          },
        ]
      : failedActions(checks),
  });
}

export function executePaperWorkSubmitPush(plan) {
  if (!plan || plan.contract !== PAPER_WORK_SUBMIT_PLAN_CONTRACT || !plan.ok) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      pushed: false,
      errorCode: "paper-work-submit-blocked",
    };
  }
  const currentHead = gitValue(plan.cwd, ["rev-parse", "HEAD"]);
  const currentBranch = gitValue(plan.cwd, ["branch", "--show-current"]);
  const currentClean =
    gitResult(plan.cwd, ["status", "--porcelain"]).stdout === "";
  const target = remoteBranchObservation(plan.cwd, plan.target.branch);
  if (
    currentHead !== plan.source.sha ||
    currentBranch !== plan.source.branch ||
    !currentClean ||
    target.sha !== plan.target.sha
  ) {
    return {
      ...plan,
      ok: false,
      dryRun: false,
      pushed: false,
      errorCode: "paper-work-submit-race",
    };
  }
  const pushed = gitResult(plan.cwd, [
    "push",
    "--set-upstream",
    "origin",
    `HEAD:refs/heads/${plan.source.branch}`,
  ]);
  return {
    ...plan,
    ok: pushed.ok,
    dryRun: false,
    pushed: pushed.ok,
    errorCode: pushed.ok ? "" : "paper-work-push-failed",
    stderr: pushed.ok ? "" : pushed.error || pushed.stderr,
  };
}
