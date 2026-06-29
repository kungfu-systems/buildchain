import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  assertPromotableRepository,
  assertPromotableTargetRef,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  latestAlphaForPatch,
  parseTags,
  promoteBuildchainRefs,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
} = require("../actions/promote-buildchain-ref/lib.js");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function notFound() {
  return Object.assign(new Error("Reference does not exist"), {
    status: 422,
    response: { data: { message: "Reference does not exist" } },
  });
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
  assert.throws(
    () => assertPromotableRepository("kungfu-systems", "other"),
    /limited to kungfu-systems\/buildchain/,
  );
  assert.throws(
    () => assertPromotableTargetRef("dev/v1/v1.0"),
    /alpha\/vN\/vN\.M or release\/vN\/vN\.M/,
  );
  assert.throws(
    () => assertPromotableTargetRef("release/v1/v2.0"),
    /major mismatch/,
  );
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1.0-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.1"), ["v1", "v1.1"]);
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
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
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
      name: "@kungfu-systems/buildchain",
      version: "1.0.0-alpha.0",
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

test("release promotion rerun reuses prepared next alpha version commit", async () => {
  const releaseSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/buildchain",
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
            data: {
              required_pull_request_reviews: { required_approving_review_count: 1 },
              required_status_checks: { strict: true, contexts: ["check"] },
            },
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
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.slice(0, 2), [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["getRef", "tags/v1.0.0-alpha.0"],
  ]);
});

test("strict alpha promotion accepts protected branch fallback when protection details are unreadable", async () => {
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
        getBranch: async ({ branch }) => {
          calls.push(["getBranch", branch]);
          return { data: { protected: true } };
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

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls, [
    ["getBranchProtection", "alpha/v1/v1.0"],
    ["getBranch", "alpha/v1/v1.0"],
  ]);
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
          data: {
            required_pull_request_reviews: { required_approving_review_count: 1 },
              required_status_checks: { strict: true, contexts: ["check"] },
          },
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

test("strict release promotion requires a matching alpha tree and alpha-to-release PR", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/buildchain",
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
          data: {
            required_pull_request_reviews: { required_approving_review_count: 1 },
              required_status_checks: { strict: true, contexts: ["check"] },
          },
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
          data: {
            required_pull_request_reviews: { required_approving_review_count: 1 },
            required_status_checks: { strict: true, contexts: ["check"] },
          },
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
