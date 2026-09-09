import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/u;

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact 40-hex Git SHA`);
  return normalized;
}

function git(args, { cwd, encoding = "utf8" }) {
  const result = spawnSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`,
    );
  return encoding === null ? result.stdout : String(result.stdout || "").trim();
}

function patchRoot(base, head, cwd) {
  const patch = git(
    [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      `${base}..${head}`,
    ],
    { cwd, encoding: null },
  );
  return `sha256:${crypto.createHash("sha256").update(patch).digest("hex")}`;
}

function linearRange(base, head, cwd) {
  try {
    git(["merge-base", "--is-ancestor", base, head], { cwd });
  } catch {
    return null;
  }
  const commits = git(
    ["rev-list", "--reverse", "--topo-order", `${base}..${head}`],
    { cwd },
  )
    .split(/\s+/u)
    .filter(Boolean);
  if (commits.length === 0) return null;
  let expectedParent = base;
  const trees = [];
  const patchRoots = [];
  for (const rangeCommit of commits) {
    const [observedCommit, ...parents] = git(
      ["rev-list", "--parents", "-n", "1", rangeCommit],
      { cwd },
    ).split(/\s+/u);
    if (
      observedCommit !== rangeCommit ||
      parents.length !== 1 ||
      parents[0] !== expectedParent
    ) {
      return null;
    }
    trees.push(
      exactSha(
        git(["rev-parse", `${rangeCommit}^{tree}`], { cwd }),
        "replayedCommitTree",
      ),
    );
    patchRoots.push(patchRoot(expectedParent, rangeCommit, cwd));
    expectedParent = rangeCommit;
  }
  return { commits, trees, patchRoots };
}

export function exactMergeGroupBinding(input = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const mergeGroupHead = exactSha(input.mergeGroupHead, "mergeGroupHead");
  const expectedTree = exactSha(input.mergeGroupTree, "mergeGroupTree");
  const qualifiedBase = exactSha(input.qualifiedBase, "qualifiedBase");
  const currentBase = exactSha(input.currentBase, "currentBase");
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const sourcePatchRoot = String(input.sourcePatchRoot || "").trim();
  const actualTree = exactSha(
    git(["rev-parse", `${mergeGroupHead}^{tree}`], { cwd }),
    "mergeGroupTree",
  );
  if (actualTree !== expectedTree)
    return { ok: false, reason: "merge-group-tree-mismatch" };
  try {
    git(["merge-base", "--is-ancestor", qualifiedBase, currentBase], { cwd });
  } catch {
    return {
      ok: false,
      reason: "current-base-not-descendant-of-qualified-base",
    };
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(sourcePatchRoot))
    throw new Error("sourcePatchRoot must be an exact SHA-256 root");
  if (patchRoot(currentBase, mergeGroupHead, cwd) !== sourcePatchRoot)
    return { ok: false, reason: "merge-group-source-patch-mismatch" };

  const [commit, ...parents] = git(
    ["rev-list", "--parents", "-n", "1", mergeGroupHead],
    { cwd },
  ).split(/\s+/u);
  if (commit !== mergeGroupHead)
    return { ok: false, reason: "merge-group-parent-mismatch" };
  if (
    parents.length === 2 &&
    parents[0] === currentBase &&
    parents[1] === sourceHead
  ) {
    return {
      ok: true,
      mergeGroupHead,
      mergeGroupTree: actualTree,
      parents,
      compositionMode: "two-parent-merge",
      replayedCommitTrees: [],
      replayedCommitPatchRoots: [],
    };
  }

  const sourceRange = linearRange(qualifiedBase, sourceHead, cwd);
  const mergeGroupRange = linearRange(currentBase, mergeGroupHead, cwd);
  if (
    !sourceRange ||
    !mergeGroupRange ||
    sourceRange.commits.length !== mergeGroupRange.commits.length ||
    sourceRange.patchRoots.some(
      (root, index) => root !== mergeGroupRange.patchRoots[index],
    )
  ) {
    return { ok: false, reason: "merge-group-parent-mismatch" };
  }
  return {
    ok: true,
    mergeGroupHead,
    mergeGroupTree: actualTree,
    parents,
    compositionMode: "linear-replay",
    replayedCommitTrees: mergeGroupRange.trees,
    replayedCommitPatchRoots: mergeGroupRange.patchRoots,
  };
}
