import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GENERATED_COMMIT_SIGN_OFF =
  "Signed-off-by: Keren Dong <keren.dong@kungfu.link>";
export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);

export const signedGeneratedCommitMessage = (message) =>
  `${message}\n\n${GENERATED_COMMIT_SIGN_OFF}`;

export function productionImpactJson({
  tag = "v1.0.0",
  line = "v1.0",
  rationale = "Production promotion preserves existing registered surfaces.",
} = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { tag, line },
    versionImpact: {
      final: "patch",
      source: "surface-register",
      rationale,
    },
    surfaceImpacts: [
      {
        id: "release-governance",
        impact: "patch",
        class: "compatible",
        rationale:
          "Promotion finalizes release evidence without changing a registered public surface.",
      },
    ],
  });
}

export function notFound() {
  return Object.assign(new Error("Reference does not exist"), {
    status: 422,
    response: { data: { message: "Reference does not exist" } },
  });
}

export function alreadyExists() {
  return Object.assign(new Error("Reference already exists"), {
    status: 422,
    response: { data: { message: "Reference already exists" } },
  });
}

export function versionStateBranchName(branch, sha) {
  return `buildchain/version-state/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
}

export function transientGitHubError(message = "other side closed") {
  return Object.assign(new Error(message), {
    status: 500,
    response: { status: 500, data: { message } },
  });
}

export function createGitMock({ refs = new Map(), orderFile = "" } = {}) {
  const blobs = new Map();
  const trees = new Map();
  const commits = new Map();
  const commitLog = [];
  let blobCount = 0;
  let treeCount = 0;
  let commitCount = 0;
  const appendOrder = (entry) => {
    if (orderFile) {
      fs.appendFileSync(orderFile, `${entry}\n`);
    }
  };
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => {
          const commit = commits.get(commit_sha);
          if (commit) {
            return { data: commit };
          }
          return { data: { tree: { sha: `tree-${commit_sha}` }, parents: [] } };
        },
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
        }),
        getBlob: async ({ file_sha }) => {
          const blob = blobs.get(file_sha);
          if (!blob) {
            throw notFound();
          }
          return { data: blob };
        },
        createBlob: async ({ content, encoding }) => {
          const sha = `blob-${++blobCount}`;
          const normalized =
            encoding === "base64"
              ? content
              : Buffer.from(content).toString("base64");
          blobs.set(sha, { content: normalized, encoding: "base64" });
          return { data: { sha } };
        },
        createTree: async ({ tree, base_tree: baseTree }) => {
          const sha = `tree-created-${++treeCount}`;
          const entries = baseTree && trees.has(baseTree) ? [...trees.get(baseTree)] : [];
          for (const entry of tree) {
            const nextEntry = { ...entry };
            const index = entries.findIndex((existing) => existing.path === nextEntry.path);
            if (index >= 0) {
              entries[index] = nextEntry;
            } else {
              entries.push(nextEntry);
            }
          }
          trees.set(sha, entries);
          return { data: { sha } };
        },
        createCommit: async ({ message, tree, parents = [] }) => {
          const sha = `commit-${++commitCount}`.padEnd(40, "0");
          const commit = {
            sha,
            tree: { sha: tree },
            parents: parents.map((parentSha) => ({ sha: parentSha })),
          };
          commits.set(sha, commit);
          commitLog.push({ sha, message, parents, tree });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          appendOrder(`update:${ref}`);
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          appendOrder(`create:${ref}`);
          const refName = ref.replace(/^refs\//, "");
          if (refs.has(refName)) {
            throw alreadyExists();
          }
          refs.set(refName, sha);
          return {};
        },
      },
    },
  };
  return { octokit, refs, blobs, trees, commits, commitLog };
}

export function makeTempWorkspace(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-promote-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
    );
  }
  return cwd;
}

export function run(command, cwd) {
  execFileSync(command[0], command.slice(1), {
    cwd,
    stdio: "ignore",
  });
}

export function protectedChannel(overrides = {}) {
  return {
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_status_checks: { strict: true, contexts: ["check"] },
    ...overrides,
  };
}
