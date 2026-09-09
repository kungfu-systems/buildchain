import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { advanceAlphaNextDevelopment } from "../packages/core/release/promote-candidate/product-provider.js";
import { nextDevelopmentRoot } from "../packages/core/release/next-development-transition.js";

const SOURCE = "a".repeat(40);
const ALPHA_RELEASE = "c".repeat(40);
const SOURCE_TREE = "1".repeat(40);
const PREPARED = "b".repeat(40);

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "next-development-"));
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist/site"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/buildchain.toml"),
    `schema = 1

[version]
required = true
derived_files = ["dist/site/kfd-claims.json"]

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.version-state]
command = "node scripts/generate.mjs"

[lifecycle.verify]
command = "node --version"
`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "4.0.2-alpha.6" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "dist/site/kfd-claims.json"),
    `${JSON.stringify({ version: "4.0.2-alpha.6" }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(cwd, "scripts/generate.mjs"),
    `import fs from "node:fs";
fs.writeFileSync("dist/site/kfd-claims.json", JSON.stringify({ version: process.env.BUILDCHAIN_VERSION }, null, 2) + "\\n");
`,
  );
  execFileSync("git", ["init", "--quiet"], { cwd });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd });
  return cwd;
}

function githubProvider(
  cwd,
  { devTree = SOURCE_TREE, enqueueFailures = [] } = {},
) {
  const refs = new Map([["heads/dev/v4/v4.0", SOURCE]]);
  const blobs = new Map();
  const sourceFiles = ["package.json", "dist/site/kfd-claims.json"].map(
    (filePath) => {
      const content = fs.readFileSync(path.join(cwd, filePath), "utf8");
      const blobSha = sha(content);
      blobs.set(blobSha, content);
      return { path: filePath, sha: blobSha };
    },
  );
  const trees = new Map([[devTree, sourceFiles]]);
  const commits = new Map([
    [SOURCE, { sha: SOURCE, tree: { sha: devTree }, parents: [] }],
  ]);
  const pulls = [];
  let enqueued = 0;
  const rest = {
    git: {
      async getRef({ ref }) {
        if (!refs.has(ref))
          throw Object.assign(new Error("not found"), { status: 404 });
        return { data: { object: { sha: refs.get(ref) } } };
      },
      async getCommit({ commit_sha: commitSha }) {
        return { data: commits.get(commitSha) };
      },
      async getTree({ tree_sha: treeSha }) {
        return { data: { tree: trees.get(treeSha) || [] } };
      },
      async getBlob({ file_sha: fileSha }) {
        return {
          data: {
            content: Buffer.from(blobs.get(fileSha)).toString("base64"),
            encoding: "base64",
          },
        };
      },
      async createBlob({ content }) {
        const blobSha = sha(content);
        blobs.set(blobSha, content);
        return { data: { sha: blobSha } };
      },
      async createTree({ base_tree: baseTree, tree }) {
        const nextTree = "2".repeat(40);
        const entries = new Map(
          (trees.get(baseTree) || []).map((entry) => [entry.path, entry]),
        );
        for (const entry of tree) entries.set(entry.path, entry);
        trees.set(nextTree, [...entries.values()]);
        return { data: { sha: nextTree } };
      },
      async createCommit({ tree, parents }) {
        commits.set(PREPARED, {
          sha: PREPARED,
          tree: { sha: tree },
          parents: parents.map((parent) => ({ sha: parent })),
        });
        return { data: commits.get(PREPARED) };
      },
      async createRef({ ref, sha: commitSha }) {
        refs.set(ref.replace(/^refs\//u, ""), commitSha);
        return { data: { object: { sha: commitSha } } };
      },
    },
    pulls: {
      async list() {
        return { data: pulls };
      },
      async create(input) {
        const pull = {
          ...input,
          number: 42,
          node_id: "PR_node",
          html_url: "https://example.test/pull/42",
          state: "open",
          merged: false,
          merged_at: null,
          base: { ref: input.base },
          head: { sha: PREPARED },
        };
        pulls.push(pull);
        return { data: pull };
      },
      async get() {
        const pull = pulls[0];
        return {
          data: {
            ...pull,
            merged: true,
            merged_at: "2026-09-03T00:00:00.000Z",
          },
        };
      },
    },
    repos: {
      async getContent({ path: filePath, ref }) {
        const commit = commits.get(ref);
        const entry = trees
          .get(commit.tree.sha)
          .find(({ path: candidate }) => candidate === filePath);
        return {
          data: {
            content: Buffer.from(blobs.get(entry.sha)).toString("base64"),
            encoding: "base64",
          },
        };
      },
      async compareCommitsWithBasehead({ basehead }) {
        const [ancestor, current] = basehead.split("...");
        return {
          data: {
            status:
              ancestor === current ||
              commits
                .get(current)
                ?.parents.some(({ sha: parent }) => parent === ancestor)
                ? "ahead"
                : "diverged",
          },
        };
      },
    },
  };
  const octokit = { rest };
  const mutationOctokit = {
    rest,
    async graphql() {
      enqueued += 1;
      const failure = enqueueFailures.shift();
      if (failure) throw failure;
      refs.set("heads/dev/v4/v4.0", PREPARED);
      return { enqueuePullRequest: { mergeQueueEntry: { id: "queue" } } };
    },
  };
  return {
    octokit,
    mutationOctokit,
    pulls,
    refs,
    get enqueued() {
      return enqueued;
    },
  };
}

test("completed Alpha creates and merges one next-version Dev PR", async () => {
  const cwd = fixture();
  const github = githubProvider(cwd);
  const result = await advanceAlphaNextDevelopment({
    cwd,
    repository: "kungfu-systems/buildchain",
    completedAlpha: {
      outcome: "succeeded",
      version: "4.0.2-alpha.6",
      exactTag: "v4.0.2-alpha.6",
      releaseSha: ALPHA_RELEASE,
      treeSha: SOURCE_TREE,
      publicationRoot: nextDevelopmentRoot({ publication: "alpha.6" }),
      completedAt: "2026-09-03T00:00:00.000Z",
    },
    octokit: github.octokit,
    mutationOctokit: github.mutationOctokit,
    wait() {},
    pollIntervalMs: 0,
    maxPolls: 2,
  });
  assert.equal(result.status, "verified");
  assert.equal(result.transition.target.version, "4.0.2-alpha.7");
  assert.equal(github.pulls.length, 1);
  assert.equal(github.pulls[0].title, "Prepare 4.0.2-alpha.7");
  assert.equal(github.enqueued, 1);
  assert.equal(github.refs.get("heads/dev/v4/v4.0"), PREPARED);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version,
    "4.0.2-alpha.6",
  );
  assert.equal(
    execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8" }),
    "",
  );
});

test("next-development retries GitHub's temporary mergeability window", async () => {
  const cwd = fixture();
  const github = githubProvider(cwd, {
    enqueueFailures: [
      new Error(
        "Pull request mergeability check has not yet completed and Pull request not in mergeable state",
      ),
    ],
  });
  const waits = [];
  const result = await advanceAlphaNextDevelopment({
    cwd,
    repository: "kungfu-systems/buildchain",
    completedAlpha: {
      outcome: "succeeded",
      version: "4.0.2-alpha.6",
      exactTag: "v4.0.2-alpha.6",
      releaseSha: ALPHA_RELEASE,
      treeSha: SOURCE_TREE,
      publicationRoot: nextDevelopmentRoot({ publication: "alpha.6" }),
      completedAt: "2026-09-03T00:00:00.000Z",
    },
    octokit: github.octokit,
    mutationOctokit: github.mutationOctokit,
    wait(delayMs) {
      waits.push(delayMs);
    },
    pollIntervalMs: 0,
    maxPolls: 2,
  });
  assert.equal(result.status, "verified");
  assert.equal(github.enqueued, 2);
  assert.deepEqual(waits, [2_000]);
});

test("next-development does not retry a non-transient queue rejection", async () => {
  const cwd = fixture();
  const github = githubProvider(cwd, {
    enqueueFailures: [new Error("Pull request not in mergeable state")],
  });
  const waits = [];
  await assert.rejects(
    advanceAlphaNextDevelopment({
      cwd,
      repository: "kungfu-systems/buildchain",
      completedAlpha: {
        outcome: "succeeded",
        version: "4.0.2-alpha.6",
        exactTag: "v4.0.2-alpha.6",
        releaseSha: ALPHA_RELEASE,
        treeSha: SOURCE_TREE,
        publicationRoot: nextDevelopmentRoot({ publication: "alpha.6" }),
        completedAt: "2026-09-03T00:00:00.000Z",
      },
      octokit: github.octokit,
      mutationOctokit: github.mutationOctokit,
      wait(delayMs) {
        waits.push(delayMs);
      },
    }),
    /not in mergeable state/u,
  );
  assert.equal(github.enqueued, 1);
  assert.deepEqual(waits, []);
});

test("next-development rejects Dev content drift after Alpha publication", async () => {
  const cwd = fixture();
  const github = githubProvider(cwd, { devTree: "3".repeat(40) });
  await assert.rejects(
    advanceAlphaNextDevelopment({
      cwd,
      repository: "kungfu-systems/buildchain",
      completedAlpha: {
        outcome: "succeeded",
        version: "4.0.2-alpha.6",
        exactTag: "v4.0.2-alpha.6",
        releaseSha: ALPHA_RELEASE,
        treeSha: SOURCE_TREE,
        publicationRoot: nextDevelopmentRoot({ publication: "alpha.6" }),
        completedAt: "2026-09-03T00:00:00.000Z",
      },
      octokit: github.octokit,
      mutationOctokit: github.mutationOctokit,
    }),
    /protected Dev tree drifted/u,
  );
});

test("anchored alpha publication preserves success and awaits the next manual anchor without GitHub calls", async () => {
  const cwd = fixture();
  const config = path.join(cwd, ".buildchain/buildchain.toml");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("required = true", 'required = true\nstrategy = "anchored"\nnext = "manual"\nmanifest = "libnode.release.json"') + '\n[[version.files]]\ntype = "json"\npath = "libnode.release.json"\nkey = "npmVersion"\n');
  const version = "22.22.3-kf.5-alpha.4";
  fs.writeFileSync(path.join(cwd, "libnode.release.json"), JSON.stringify({npmVersion: version}));
  const result = await advanceAlphaNextDevelopment({
    cwd, repository: "kungfu-systems/libnode",
    completedAlpha: {outcome: "succeeded", version, exactTag: `v${version}`, releaseSha: SOURCE,
      treeSha: SOURCE_TREE, publicationRoot: `sha256:${"1".repeat(64)}`, completedAt: "2026-09-06T00:00:00.000Z"},
    octokit: {}, mutationOctokit: {},
  });
  assert.equal(result.status, "waiting-anchor");
  assert.equal(result.transition.target.version, null);
  assert.deepEqual(result.transition.adapter.sourcePaths, ["libnode.release.json", "package.json"]);
});

test("stable publication advances divergent protected development and retries without another PR", async () => {
  const { advanceStableNextDevelopment } = await import("../packages/core/release/promote-candidate/next-development-provider.js");
  const cwd = fixture();
  const github = githubProvider(cwd, { devTree: "9".repeat(40) });
  let disposed = 0;
  const options = {
    cwd, repository: "kungfu-systems/buildchain",
    completedStable: { outcome: "succeeded", version: "4.0.2", exactTag: "v4.0.2", releaseSha: ALPHA_RELEASE, treeSha: SOURCE_TREE, publicationRoot: nextDevelopmentRoot({ stable: "4.0.2" }), completedAt: "2026-09-07T00:00:00.000Z" },
    prepareSource({ sourceSha }) { assert.ok([SOURCE, PREPARED].includes(sourceSha)); return { cwd, dispose() { disposed++; } }; },
    octokit: github.octokit, mutationOctokit: github.mutationOctokit, wait() {}, maxPolls: 2,
  };
  const result = await advanceStableNextDevelopment(options);
  assert.equal(result.status, "verified");
  assert.equal(result.transition.target.version, "4.0.3-alpha.0");
  assert.equal(github.pulls[0].base.ref, "dev/v4/v4.0");
  assert.equal((await advanceStableNextDevelopment(options)).status, "already-current");
  assert.equal(github.pulls.length, 1);
  assert.equal(disposed, 2);
});

test("late alpha completion cannot regress an advanced development patch", async () => {
  const cwd = fixture();
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "4.0.3-alpha.2" }));
  const github = githubProvider(cwd);
  const result = await advanceAlphaNextDevelopment({ cwd, repository: "kungfu-systems/buildchain", completedAlpha: { outcome: "succeeded", version: "4.0.2-alpha.6", exactTag: "v4.0.2-alpha.6", releaseSha: ALPHA_RELEASE, treeSha: SOURCE_TREE, publicationRoot: nextDevelopmentRoot({ alpha: 6 }), completedAt: "2026-09-07T00:00:00.000Z" }, ...github });
  assert.equal(result.status, "already-advanced");
  assert.equal(github.pulls.length, 0);
});
