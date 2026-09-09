import { execFileSync, spawnSync } from "node:child_process";
import {
  assertPlainObject,
  assertString,
  sha256Json,
} from "./release-propagation-common.js";
import {
  assertCommitSha,
  assertContentRoot,
  contentRoot,
} from "./release-propagation-work-control.js";
import { verifyReleasePropagationWork } from "./release-propagation-work.js";

export const RELEASE_PROPAGATION_PUSH_PLAN_CONTRACT =
  "kungfu-buildchain-release-propagation-push-plan";
export const RELEASE_PROPAGATION_PUSH_RESULT_CONTRACT =
  "kungfu-buildchain-release-propagation-push-result";

function branchName(value, label) {
  const branch = assertString(value, label);
  if (
    branch.startsWith("-") ||
    branch.startsWith("refs/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s~^:?*[\\]/.test(branch) ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("//")
  ) {
    throw new Error(`${label} is not a safe Git branch name`);
  }
  return branch;
}

function remoteName(value) {
  const name = assertString(value, "push repository state.remoteName");
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("-")) {
    throw new Error("push repository state.remoteName is unsafe");
  }
  return name;
}

function optionalCommit(value, label) {
  if (value === "") return "";
  return assertCommitSha(value, label);
}

function normalizeRepositoryState(value) {
  const state = assertPlainObject(value, "push repository state");
  return {
    repository: assertString(
      state.repository,
      "push repository state.repository",
    ),
    remoteName: remoteName(state.remoteName),
    currentBranch: branchName(
      state.currentBranch,
      "push repository state.currentBranch",
    ),
    sourceRevision: assertCommitSha(
      state.sourceRevision,
      "push repository state.sourceRevision",
    ),
    remoteBaseRevision: assertCommitSha(
      state.remoteBaseRevision,
      "push repository state.remoteBaseRevision",
    ),
    remoteBranchRevision: optionalCommit(
      state.remoteBranchRevision,
      "push repository state.remoteBranchRevision",
    ),
    expectedBaseIsAncestor: state.expectedBaseIsAncestor === true,
  };
}

export function createReleasePropagationPushPlan({
  work: workInput,
  expectedWorkRoot,
  repositoryState: stateInput,
} = {}) {
  const status = verifyReleasePropagationWork(workInput);
  const expectedRoot = assertContentRoot(expectedWorkRoot, "expectedWorkRoot");
  if (status.contentRoot !== expectedRoot) {
    throw new Error("propagation work changed before push planning");
  }
  if (
    status.lifecycle !== "ready" ||
    status.currentStage !== "push-branch" ||
    status.work.authority.mode !== "execute"
  ) {
    throw new Error("propagation work is not ready for the push-branch stage");
  }
  const state = normalizeRepositoryState(stateInput);
  const expectedBranch = branchName(
    status.work.downstream.branch,
    "propagation work downstream.branch",
  );
  if (state.repository !== status.work.downstream.repository) {
    throw new Error(
      "push remote repository disagrees with the propagation target",
    );
  }
  if (state.currentBranch !== expectedBranch) {
    throw new Error(
      "current branch disagrees with the exact propagation branch",
    );
  }
  if (state.remoteBaseRevision !== status.work.downstream.expectedBaseSha) {
    throw new Error("downstream base advanced after the propagation capture");
  }
  if (!state.expectedBaseIsAncestor) {
    throw new Error(
      "propagation branch is not based on the expected downstream base",
    );
  }
  const destinationRef = `refs/heads/${expectedBranch}`;
  const body = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_PUSH_PLAN_CONTRACT,
    workId: status.workId,
    expectedWorkRoot: expectedRoot,
    repository: state.repository,
    remoteName: state.remoteName,
    sourceRef: "HEAD",
    sourceRevision: state.sourceRevision,
    destinationRef,
    expectedBaseRevision: status.work.downstream.expectedBaseSha,
    expectedOldRevision: state.remoteBranchRevision,
    pushMode: "fast-forward-only-exact-refspec",
    argv: ["push", "--porcelain", state.remoteName, `HEAD:${destinationRef}`],
  };
  return { ...body, planRoot: sha256Json(body) };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function repositoryFromRemoteUrl(value) {
  const remoteUrl = String(value || "").trim();
  if (!remoteUrl || /[?#]/.test(remoteUrl)) {
    throw new Error("push remote URL must not contain query or fragment data");
  }
  const ssh = remoteUrl.match(
    /^[^@\s]+@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  if (ssh) return ssh[1];
  const https = remoteUrl.match(
    /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  );
  if (https) return https[1];
  throw new Error("push remote must be an exact GitHub repository URL");
}

function lsRemote(cwd, remote, ref) {
  const output = git(cwd, ["ls-remote", "--refs", remote, ref]);
  if (!output) return "";
  const rows = output.split("\n").filter(Boolean);
  if (rows.length !== 1) {
    throw new Error(`expected exactly one remote ref for ${ref}`);
  }
  const [revision, observedRef] = rows[0].split(/\s+/);
  if (observedRef !== ref) {
    throw new Error(`remote ref lookup disagrees with ${ref}`);
  }
  return assertCommitSha(revision, `remote ${ref}`);
}

export function inspectReleasePropagationPushState({
  work: workInput,
  cwd = process.cwd(),
  remote = "origin",
} = {}) {
  const status = verifyReleasePropagationWork(workInput);
  const expectedBranch = branchName(
    status.work.downstream.branch,
    "propagation work downstream.branch",
  );
  const baseRef = branchName(
    status.work.downstream.baseRef,
    "propagation work downstream.baseRef",
  );
  const normalizedRemote = remoteName(remote);
  const repository = repositoryFromRemoteUrl(
    git(cwd, ["remote", "get-url", normalizedRemote]),
  );
  const sourceRevision = assertCommitSha(
    git(cwd, ["rev-parse", "HEAD"]),
    "push source revision",
  );
  const ancestor = spawnSync(
    "git",
    [
      "merge-base",
      "--is-ancestor",
      status.work.downstream.expectedBaseSha,
      sourceRevision,
    ],
    { cwd, encoding: "utf8" },
  );
  if (ancestor.error) throw ancestor.error;
  if (ancestor.status !== 0) {
    throw new Error(
      "propagation branch is not based on the expected downstream base",
    );
  }
  return {
    repository,
    remoteName: normalizedRemote,
    currentBranch: git(cwd, ["branch", "--show-current"]),
    sourceRevision,
    remoteBaseRevision: lsRemote(
      cwd,
      normalizedRemote,
      `refs/heads/${baseRef}`,
    ),
    remoteBranchRevision: lsRemote(
      cwd,
      normalizedRemote,
      `refs/heads/${expectedBranch}`,
    ),
    expectedBaseIsAncestor: true,
  };
}

export function executeReleasePropagationPush({
  work,
  expectedWorkRoot,
  cwd = process.cwd(),
  remote = "origin",
} = {}) {
  const repositoryState = inspectReleasePropagationPushState({
    work,
    cwd,
    remote,
  });
  const plan = createReleasePropagationPushPlan({
    work,
    expectedWorkRoot,
    repositoryState,
  });
  let mutation = true;
  let output = "";
  if (plan.expectedOldRevision === plan.sourceRevision) {
    mutation = false;
  } else {
    output = git(cwd, plan.argv);
  }
  const observedRevision = lsRemote(cwd, plan.remoteName, plan.destinationRef);
  if (observedRevision !== plan.sourceRevision) {
    throw new Error(
      "remote branch readback disagrees with the pushed source revision",
    );
  }
  const claims = {
    provider: "git",
    repository: plan.repository,
    remoteName: plan.remoteName,
    sourceRef: plan.sourceRef,
    sourceRevision: plan.sourceRevision,
    destinationRef: plan.destinationRef,
    expectedBaseRevision: plan.expectedBaseRevision,
    expectedOldRevision: plan.expectedOldRevision,
    observedRevision,
    pushMode: plan.pushMode,
    argv: plan.argv,
    mutation,
  };
  const evidence = {
    kind: "git-branch-reconciliation",
    root: contentRoot(claims),
    locator: "buildchain://release-propagation/branch-reconciliation",
    repository: plan.repository,
    revision: observedRevision,
    httpStatus: null,
    bytes: Buffer.byteLength(output),
    claims,
  };
  const body = {
    schemaVersion: 1,
    contract: RELEASE_PROPAGATION_PUSH_RESULT_CONTRACT,
    status: mutation ? "pushed" : "already-current",
    mutation,
    plan,
    evidence,
  };
  return { ...body, resultRoot: sha256Json(body) };
}
