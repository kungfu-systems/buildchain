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
  selectReleaseTag,
} = require("../actions/promote-buildchain-ref/lib.js");

const SHA = "a".repeat(40);

test("parseTags accepts only buildchain compatibility tags", () => {
  assert.deepEqual(parseTags("v1, v1.0, v1-alpha, 1.0.0, v1"), ["v1", "v1.0", "v1-alpha", "1.0.0"]);
  assert.throws(() => parseTags("latest"), /Unsupported buildchain promotion tag/);
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
  assert.throws(() => assertPromotableTargetRef("dev/v1/v1.0"), /alpha\/vN\/vN\.M or release\/vN\/vN\.M/);
  assert.throws(() => assertPromotableTargetRef("release/v1/v2.0"), /major mismatch/);
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.1"), ["v1", "v1.1"]);
  assert.throws(() => resolveTagsForTarget("alpha/v1/v1.0", ["v1"]), /not allowed for alpha promotion/);
  assert.throws(() => resolveTagsForTarget("release/v1/v1.0", ["1.1.0"]), /not allowed for release promotion/);
});

test("selectReleaseTag creates the first patch tag, increments, and reuses same-sha tags", () => {
  assert.deepEqual(selectReleaseTag({ refs: [], releasePrefix: "1.0", sha: SHA }), {
    tag: "1.0.0",
    exists: false,
  });
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/1.0.0", object: { sha: "b".repeat(40) } },
        { ref: "refs/tags/1.0.1", object: { sha: SHA } },
      ],
      releasePrefix: "1.0",
      sha: SHA,
    }),
    { tag: "1.0.1", exists: true },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [{ ref: "refs/tags/1.0.0", object: { sha: "b".repeat(40) } }],
      releasePrefix: "1.0",
      sha: SHA,
    }),
    { tag: "1.0.1", exists: false },
  );
});

test("promoteBuildchainRefs creates release patch tag before moving compatibility refs", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/release/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw Object.assign(new Error("not found"), { status: 404 });
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return { data: [{ ref: "refs/tags/1.0.0", object: { sha: "b".repeat(40) } }] };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          if (ref === "tags/v1.0") {
            throw Object.assign(new Error("Reference does not exist"), {
              status: 422,
              response: { data: { message: "Reference does not exist" } },
            });
          }
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
    { tag: "1.0.1", action: "created", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0", action: "created", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["listMatchingRefs", "tags/1.0."],
    ["getRef", "tags/1.0.1"],
    ["createRef", "refs/tags/1.0.1", SHA],
    ["updateRef", "tags/v1", SHA, true],
    ["updateRef", "tags/v1.0", SHA, true],
    ["createRef", "refs/tags/v1.0", SHA],
  ]);
});

test("explicit release patch tag still moves default compatibility refs", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/release/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw Object.assign(new Error("not found"), { status: 404 });
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
    tags: ["1.0.5"],
  });

  assert.deepEqual(result.updates, [
    { tag: "1.0.5", action: "created", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["getRef", "tags/1.0.5"],
    ["createRef", "refs/tags/1.0.5", SHA],
    ["updateRef", "tags/v1", SHA, true],
    ["updateRef", "tags/v1.0", SHA, true],
  ]);
});

test("promoteBuildchainRefs rejects stale target SHA", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: "b".repeat(40) } } }),
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
