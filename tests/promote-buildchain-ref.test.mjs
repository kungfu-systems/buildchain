import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  assertAllowedLocalChanges,
  assertPromotableRepository,
  assertPromotableTargetRef,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  latestAlphaForPatch,
  parseReleaseLineRef,
  parseTags,
  persistDurableReleaseTransaction,
  promoteBuildchainRefs,
  restoreDurableReleaseTransaction,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
} = await import("../actions/promote-buildchain-ref/lib.js");
const {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} = await import("../packages/core/release-line-dry-run.js");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function notFound() {
  return Object.assign(new Error("Reference does not exist"), {
    status: 422,
    response: { data: { message: "Reference does not exist" } },
  });
}

function alreadyExists() {
  return Object.assign(new Error("Reference already exists"), {
    status: 422,
    response: { data: { message: "Reference already exists" } },
  });
}

function createGitMock({ refs = new Map(), orderFile = "" } = {}) {
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

function makeTempWorkspace(files) {
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

function run(command, cwd) {
  execFileSync(command[0], command.slice(1), {
    cwd,
    stdio: "ignore",
  });
}

function protectedChannel(overrides = {}) {
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

test("parseTags accepts only ABV-style buildchain tags", () => {
  assert.deepEqual(
    parseTags("v1, v1.0, v1.0-alpha, v1.0.0, v1.0.1-alpha.0, v1"),
    ["v1", "v1.0", "v1.0-alpha", "v1.0.0", "v1.0.1-alpha.0"],
  );
  assert.throws(
    () => parseTags("1.0.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("v1-alpha"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("v1.0.1.alpha.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("latest"),
    /Unsupported buildchain promotion tag/,
  );
});

test("promotion is limited to buildchain alpha and release line refs", () => {
  assertPromotableRepository("kungfu-systems", "buildchain");
  assertPromotableTargetRef("alpha/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.1");
  assertPromotableTargetRef("publish-gate/major");
  assertPromotableTargetRef("major-gate");
  assert.throws(
    () => assertPromotableRepository("kungfu-systems", "other"),
    /limited to kungfu-systems\/buildchain/,
  );
  assert.throws(
    () => assertPromotableTargetRef("dev/v1/v1.0"),
    /alpha\/vN\/vN\.M, release\/vN\/vN\.M, publish-gate\/major, or major-gate/,
  );
  assert.throws(
    () => assertPromotableTargetRef("release/v1/v2.0"),
    /major mismatch/,
  );
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1.0-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.1"), ["v1", "v1.1"]);
  assert.deepEqual(resolveTagsForTarget("publish-gate/major"), []);
  assert.deepEqual(resolveTagsForTarget("major-gate"), []);
  assert.throws(
    () => resolveTagsForTarget("alpha/v1/v1.0", ["v1"]),
    /not allowed for alpha promotion/,
  );
  assert.throws(
    () => resolveTagsForTarget("release/v1/v1.0", ["v1.1.0"]),
    /not allowed for release promotion/,
  );
});

test("governance maps channel targets to the only legal PR source", () => {
  assert.equal(expectedHeadRefForTarget("alpha/v1/v1.0"), "dev/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("release/v1/v1.0"), "alpha/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("publish-gate/major"), "release/vN/vN.M");
  assert.equal(expectedHeadRefForTarget("major-gate"), "release/vN/vN.M");
  assert.deepEqual(parseReleaseLineRef("release/v1/v1.0"), {
    ref: "release/v1/v1.0",
    major: 1,
    minor: 0,
  });
  assert.deepEqual(
    latestAlphaForPatch(
      [
        { ref: "refs/tags/v1.0.2-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.2-alpha.1", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.3-alpha.0", object: { sha: "c".repeat(40) } },
      ],
      "v1.0",
      2,
    ),
    { tag: "v1.0.2-alpha.1", patch: 2, prerelease: 1, sha: OTHER_SHA },
  );
});

test("release line dry-run explains alpha promotion semantics", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "fixture",
      version: "2.0.0-alpha.0",
    },
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "alpha/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "alpha");
  assert.equal(plan.source.expectedHeadRef, "dev/v2/v2.0");
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "alpha/v2/v2.0",
    "dev/v2/v2.0",
  ]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0-alpha"]);
  assert.match(formatReleaseLineDryRun(plan), /No refs, tags, packages, or files were modified/);
});

test("release line dry-run explains production and next-alpha semantics", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `schema = 1

[version]
required = true

[[version.files]]
path = "VERSION"
type = "regex"
pattern = "VERSION=(?<version>[^\\n]+)"
replacement = "VERSION={{version}}"
`,
    VERSION: "VERSION=2.0.1-alpha.0\n",
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "release/v2/v2.0",
    sha: SHA,
    tags: ["v2.0.1", "v2.0.2-alpha.0"],
    publishTransaction: true,
  });

  assert.equal(plan.channel, "release");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v2.0.1", "v2.0.2-alpha.0"]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0", "v2", "v2.0-alpha"]);
  assert.equal(plan.publishTransaction.enabled, true);
  assert.equal(plan.versionState.manager, "buildchain.toml");
  assert.deepEqual(plan.versionState.files, ["VERSION"]);
  assert.match(plan.governanceChecks.join("\n"), /same-patch exact alpha tag tree/);
});

test("release line dry-run resolves major gate from explicit source ref", () => {
  const plan = explainReleaseLineDryRun({
    cwd: makeTempWorkspace({}),
    targetRef: "publish-gate/major",
    sourceRef: "release/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "major");
  assert.equal(plan.line, "v3.0");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v3.0.0", "v3.0.1-alpha.0"]);
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "publish-gate/major",
    "release/v3/v3.0",
    "alpha/v3/v3.0",
    "dev/v3/v3.0",
  ]);
});

test("selectReleaseTag creates, increments, and reuses canonical v-prefixed release tags", () => {
  assert.deepEqual(
    selectReleaseTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0",
      patch: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1", object: { sha: SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1", patch: 1, exists: true },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/1.0.99", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1", patch: 1, exists: false },
  );
});

test("selectAlphaTag creates ABV-style prerelease tags for the minor line", () => {
  assert.deepEqual(
    selectAlphaTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0-alpha.0",
      patch: 0,
      prerelease: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.0", patch: 1, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    {
      tag: "v1.0.1-alpha.0",
      patch: 1,
      prerelease: 0,
      sha: SHA,
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    {
      tag: "v1.0.1-alpha.0",
      patch: 1,
      prerelease: 0,
      sha: OTHER_SHA,
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
});

test("discoverVersionStateFiles follows package-manager workspace metadata", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "actions/no-version/package.json": {
      name: "@kungfu-systems/no-version",
      private: true,
    },
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "pnpm");
  assert.deepEqual(
    discovered.files.map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
  assert.deepEqual(
    updateVersionStateContents(discovered.files, "1.0.1").map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
});

test("discoverVersionStateFiles prefers buildchain.toml version state", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pyproject.toml": '[project]\nname = "example"\nversion = "1.0.0-alpha.0"\n',
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "buildchain.toml");
  assert.deepEqual(discovered.files.map((file) => file.path), ["pyproject.toml"]);
  const changed = updateVersionStateContents(discovered.files, "1.0.1");
  assert.equal(changed.length, 1);
  assert.match(changed[0].content, /version = "1.0.1"/);
});

test("version verification allows only discovered version-state file changes", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "actions/one/package.json"),
    JSON.stringify({ name: "@kungfu-systems/one", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "changed\n");

  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
    /README\.md/,
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  assert.doesNotThrow(() =>
    assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
  );
});

test("release promotion creates v-prefixed release tag and prepares next alpha tag", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/release/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return { data: [] };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["getRef", "tags/v1.0.0"],
    ["createRef", "refs/tags/v1.0.0", SHA],
    ["updateRef", "tags/v1.0", SHA, true],
    ["getRef", "tags/v1.1"],
    ["updateRef", "tags/v1", SHA, true],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
  ]);
});

test("release promotion does not move v1 when the next minor line exists", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/release/v1/v1.0" || ref === "tags/v1.1") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        updateRef: async () => ({}),
        createRef: async () => ({}),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "skipped-next-minor-exists", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
});

test("alpha promotion creates exact prerelease tag and moves only the minor alpha tag", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return {
            data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
          };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
  ]);
});

test("rerunning the same release SHA reuses exact tags", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (
            ref === "heads/release/v1/v1.0" ||
            ref === "tags/v1.0.0" ||
            ref === "tags/v1.0.1-alpha.0"
          ) {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({
          data: [
            { ref: "refs/tags/v1.0.0", object: { sha: SHA } },
            { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } },
          ],
        }),
        updateRef: async () => ({}),
        createRef: async () => {
          throw new Error("createRef should not be called for exact tags");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "existing", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
});

test("release promotion creates source version commits and points refs at them", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.0-alpha.0",
      private: true,
    },
  });
  const refs = new Map([["heads/release/v1/v1.0", SHA]]);
  const blobs = [];
  const commits = [];
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
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async ({ content }) => {
          const sha = `blob-${blobs.length + 1}`;
          blobs.push({ sha, content });
          return { data: { sha } };
        },
        createTree: async ({ tree }) => ({
          data: { sha: `tree-created-${tree.map((item) => item.sha).join("-")}` },
        }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      ["chore(release): release v1.0.0", [SHA]],
      ["chore(release): prepare v1.0.1-alpha.0", [releaseSha]],
    ],
  );
  assert.equal(blobs.length, 4);
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "1.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "1.0.1-alpha.0"')),
  );
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "created-version-state")
      .map((update) => [update.version, update.packageManager]),
    [
      ["1.0.0", "pnpm"],
      ["1.0.1-alpha.0", "pnpm"],
    ],
  );
});

test("publish transaction gates alpha final refs on lifecycle.publish evidence", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.appendFileSync("order.log", "publish\\n");
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commitLog } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha",
      },
    ]),
  });

  const alphaSha = commitLog[0].sha;
  assert.equal(result.sha, alphaSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), alphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaSha);
  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8").trim().split("\n");
  assert.equal(order[0], "create:refs/heads/buildchain/release-state/1-0-0-alpha-0");
  assert.equal(order.filter((entry) => entry.includes("buildchain/release-state")).length >= 4, true);
  assert.deepEqual(order.filter((entry) => !entry.includes("buildchain/release-state")), [
    "publish",
    "update:heads/alpha/v1/v1.0",
    "create:refs/heads/dev/v1/v1.0",
    "create:refs/tags/v1.0.0-alpha.0",
    "update:tags/v1.0-alpha",
  ]);
});

test("publish transaction skips alpha versions occupied by durable state refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha1",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), true);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-1"), true);
});

test("publish transaction durable ref restores state and evidence in a fresh workspace", async () => {
  const sourceCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(sourceCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const transaction = {
    schema: 1,
    id: "tx-1",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: evidencePath,
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [{ kind: "npm", name: "@kungfu-tech/buildchain", ref: "1.0.0", digest: "sha256:ok", group: "", required: true }],
    evidence: [".buildchain/release-evidence/1.0.0/evidence.json"],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version: "1.0.0",
    channel: "release",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    target_ref: "release/v1/v1.0",
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    artifacts: transaction.artifacts,
  }, null, 2) + "\n");

  const { octokit } = createGitMock();
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd: sourceCwd,
    transaction,
    evidencePath,
  });

  const freshCwd = makeTempWorkspace({});
  const freshStatePath = path.join(freshCwd, ".buildchain/release-state/1.0.0.json");
  const freshEvidencePath = path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const restored = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0",
    statePath: freshStatePath,
    evidencePath: freshEvidencePath,
  });

  assert.equal(restored.id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshStatePath, "utf8")).id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshEvidencePath, "utf8")).artifacts[0].digest, "sha256:ok");
});

test("publish transaction durable ref updates when create races existing ref visibility", async () => {
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const baseTransaction = {
    schema: 1,
    id: "tx-visibility-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const orderFile = path.join(cwd, "order.log");
  const { octokit, refs } = createGitMock({ orderFile });

  const first = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: baseTransaction,
    evidencePath: "",
  });

  const originalGetRef = octokit.rest.git.getRef;
  let hideStateRefOnce = true;
  octokit.rest.git.getRef = async (args) => {
    if (hideStateRefOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      hideStateRefOnce = false;
      throw notFound();
    }
    return originalGetRef(args);
  };

  const second = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      ...baseTransaction,
      state: "publishing",
      previous_state: "prepared",
      updated_at: "2026-07-01T00:00:01.000Z",
    },
    evidencePath: "",
  });

  assert.notEqual(second.sha, first.sha);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), second.sha);
  assert.deepEqual(fs.readFileSync(orderFile, "utf8").trim().split("\n"), [
    "create:refs/heads/buildchain/release-state/1-0-0",
    "create:refs/heads/buildchain/release-state/1-0-0",
    "update:heads/buildchain/release-state/1-0-0",
  ]);
});

test("publish transaction fails closed when durable state cannot be persisted", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalCreateRef = octokit.rest.git.createRef;
  octokit.rest.git.createRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      throw new Error("durable state write denied");
    }
    return originalCreateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable state write denied/,
  );

  assert.equal(fs.existsSync(path.join(cwd, "order.log")), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("anchored manual release verifies existing anchor state and does not prepare next alpha", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.0",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      nodeCommit: "abc123",
      libnodeRevision: "kf.0",
      npmVersion: "22.22.3-kf.0",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));
const fields = JSON.parse(process.env.BUILDCHAIN_ANCHOR_MANIFEST_JSON);

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(pkg.version, "22.22.3-kf.0");
assert.equal(anchor.npmVersion, pkg.version);
assert.equal(fields.nodeTag, "v22.22.3");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const refs = new Map([["heads/release/v22/v22.22", SHA]]);
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
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.nextAlphaSha, undefined);
  assert.equal(refs.get("heads/release/v22/v22.22"), SHA);
  assert.equal(refs.get("heads/alpha/v22/v22.22"), undefined);
  assert.equal(refs.get("heads/dev/v22/v22.22"), undefined);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
  assert.equal(refs.get("tags/v22.22-alpha"), undefined);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "anchored-manual-version-state" || update.action === "next-anchor-required")
      .map((update) => [update.action, update.version || update.ref, update.manifest]),
    [
      ["anchored-manual-version-state", "22.22.0", "libnode.release.json"],
      ["next-anchor-required", "dev/v22/v22.22", "libnode.release.json"],
    ],
  );
});

test("publish-gate/major promotion publishes next major production and prepares next alpha", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.10",
      private: true,
    },
  });
  const refs = new Map([["heads/publish-gate/major", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
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
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async ({ content }) => {
          const sha = `blob-${blobs.length + 1}`;
          blobs.push({ sha, content });
          return { data: { sha } };
        },
        createTree: async ({ tree }) => ({
          data: { sha: `tree-created-${tree.map((item) => item.sha).join("-")}` },
        }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        update: async (input) => {
          repoUpdates.push(input);
          return {};
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v2/v2.0",
    },
  ]);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      ["chore(release): release v2.0.0", [SHA]],
      ["chore(release): prepare v2.0.1-alpha.0", [releaseSha]],
    ],
  );
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "2.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "2.0.1-alpha.0"')),
  );
});

test("release promotion rerun reuses prepared next alpha version commit", async () => {
  const releaseSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", releaseSha],
    ["tags/v1.0.0", releaseSha],
    ["tags/v1.0.1-alpha.0", nextAlphaSha],
  ]);
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
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        createCommit: async () => {
          throw new Error("createCommit should not be called on rerun");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseSha,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    result.updates
      .filter((update) => update.version)
      .map((update) => [update.version, update.action, update.sha]),
    [
      ["1.0.0", "existing-version-state", releaseSha],
      ["1.0.1-alpha.0", "existing-version-state", nextAlphaSha],
    ],
  );
});

test("promoteBuildchainRefs rejects stale target SHA", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: OTHER_SHA } } }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
    }),
    /not requested SHA/,
  );
});

test("strict alpha promotion requires a protected dev-to-alpha PR", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: protectedChannel(),
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-29T00:00:00Z",
                base: { ref: "alpha/v1/v1.0" },
                head: {
                  ref: "dev/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.slice(0, 2), [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["getRef", "tags/v1.0.0-alpha.0"],
  ]);
});

test("strict alpha promotion rejects unreadable protection details", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          calls.push(["getBranchProtection", branch]);
          const error = new Error("Resource not accessible by integration");
          error.status = 403;
          throw error;
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /protection details must be readable/,
  );

  assert.deepEqual(calls, [["getBranchProtection", "alpha/v1/v1.0"]]);
});

test("strict alpha promotion rejects protection without admin enforcement", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({ enforce_admins: { enabled: false } }),
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must enforce branch protection for administrators/,
  );
});

test("strict alpha promotion rejects protection bypass surfaces", async () => {
  for (const [override, pattern] of [
    [
      { allow_force_pushes: { enabled: true } },
      /must disallow force pushes/,
    ],
    [
      { allow_deletions: { enabled: true } },
      /must disallow branch deletion/,
    ],
    [
      { required_conversation_resolution: { enabled: false } },
      /must require conversation resolution/,
    ],
  ]) {
    const octokit = {
      rest: {
        git: {
          getRef: async ({ ref }) => {
            if (ref === "heads/alpha/v1/v1.0") {
              return { data: { object: { sha: SHA } } };
            }
            throw notFound();
          },
          listMatchingRefs: async () => ({ data: [] }),
        },
        repos: {
          getBranchProtection: async () => ({
            data: protectedChannel(override),
          }),
        },
      },
    };

    await assert.rejects(
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        versionState: false,
        requireGovernance: true,
      }),
      pattern,
    );
  }
});

test("strict alpha promotion rejects missing PR lineage", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "feature/direct",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must come from a merged same-repository PR dev\/v1\/v1\.0 -> alpha\/v1\/v1\.0/,
  );
});

test("strict alpha promotion no-ops settled generated version-state commits", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.4-alpha.0", SHA],
    ["tags/v1.0-alpha", SHA],
  ]);
  const writes = [];
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
        createRef: async (args) => {
          writes.push(["createRef", args.ref]);
          return {};
        },
        updateRef: async (args) => {
          writes.push(["updateRef", args.ref]);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => {
          assert.fail("settled alpha version-state commits should not need PR lookup");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.updates, [
    { ref: "alpha/v1/v1.0", action: "already-promoted", sha: SHA },
    { ref: "dev/v1/v1.0", action: "already-promoted", sha: SHA },
    { tag: "v1.0.4-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "existing", sha: SHA },
  ]);
});

test("strict alpha promotion opens a version-state PR for protected branches", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "c".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const pullRequests = [];
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
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            const error = new Error('Changes must be made through a pull request. Required status check "check" is expected.');
            error.status = 422;
            throw error;
          }
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ title, head, base }) => {
          const pullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/100",
            title,
            head: { ref: head },
            base: { ref: base },
          };
          pullRequests.push(pullRequest);
          return { data: pullRequest };
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.pendingPullRequest, "https://github.com/kungfu-systems/buildchain/pull/100");
  assert.equal(pullRequests[0].base.ref, "alpha/v1/v1.0");
  assert.equal(pullRequests[0].head.ref, `buildchain/version-state/alpha-v1-v1.0/${versionSha.slice(0, 12)}`);
  assert.equal(refs.get(`heads/${pullRequests[0].head.ref}`), versionSha);
  assert.deepEqual(
    result.updates.map((update) => update.action),
    ["created-version-state", "pending-version-state-pr"],
  );
});

test("strict alpha promotion accepts reviewed version-state PRs from a legal parent", async () => {
  const versionSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", versionSha],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents: commit_sha === versionSha ? [{ sha: SHA }] : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "dev/v1/v1.0",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/cccccccccccc",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: versionSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, versionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), versionSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), versionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), versionSha);
});

test("strict alpha promotion accepts merged generated version-state PR commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
  ]);
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
});

test("strict alpha promotion finalizes tags when dev already advanced", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const advancedDevSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", advancedDevSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
  ]);
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            throw Object.assign(new Error("Update is not a fast forward"), {
              status: 422,
              response: { data: { message: "Update is not a fast forward" } },
            });
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), advancedDevSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.deepEqual(
    result.updates.find(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "skipped-non-fast-forward",
    ),
    {
      ref: "dev/v1/v1.0",
      action: "skipped-non-fast-forward",
      sha: mergeSha,
      currentSha: advancedDevSha,
    },
  );
});

test("strict release promotion requires a matching alpha tree and alpha-to-release PR", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === OTHER_SHA ? "old-release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "d".repeat(40) } }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "release/v1/v1.0" },
              head: {
                ref: "alpha/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, "d".repeat(40));
  assert.equal(refs.get("tags/v1.0.2"), "d".repeat(40));
});

test("strict release promotion rejects code changes after alpha", async () => {
  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === SHA ? "release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must have the same tree as v1\.0\.2-alpha\.0/,
  );
});

test("strict promotion rejects repositories without version state", async () => {
  const cwd = makeTempWorkspace({ "README.md": "no package state\n" });
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      cwd,
      requireVersionState: true,
    }),
    /requires package version state/,
  );
});
