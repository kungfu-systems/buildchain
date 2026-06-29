import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  assertPromotableRepository,
  assertPromotableTargetRef,
  parseTags,
  promoteBuildchainRefs,
  resolveTagsForTarget,
  selectAlphaTag,
  selectReleaseTag,
} = require("../actions/promote-buildchain-ref/lib.js");

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function notFound() {
  return Object.assign(new Error("Reference does not exist"), {
    status: 422,
    response: { data: { message: "Reference does not exist" } },
  });
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
    { tag: "v1.0.1-alpha.0", patch: 1, prerelease: 0, exists: true },
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
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
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
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "existing", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
  ]);
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
    }),
    /not requested SHA/,
  );
});
