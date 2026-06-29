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
} = require("../actions/promote-buildchain-ref/lib.js");

const SHA = "a".repeat(40);

test("parseTags accepts only buildchain compatibility tags", () => {
  assert.deepEqual(parseTags("v1, v1.0, v1-alpha, v1"), ["v1", "v1.0", "v1-alpha"]);
  assert.throws(() => parseTags("latest"), /Unsupported buildchain promotion tag/);
});

test("promotion is limited to buildchain alpha and release refs", () => {
  assertPromotableRepository("kungfu-systems", "buildchain");
  assertPromotableTargetRef("alpha/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.0");
  assert.throws(
    () => assertPromotableRepository("kungfu-systems", "other"),
    /limited to kungfu-systems\/buildchain/,
  );
  assert.throws(() => assertPromotableTargetRef("dev/v1/v1.0"), /alpha\/v1\/v1\.0 or release\/v1\/v1\.0/);
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.throws(() => resolveTagsForTarget("alpha/v1/v1.0", ["v1"]), /not allowed for alpha promotion/);
});

test("promoteBuildchainRefs updates existing tags and creates missing tags", async () => {
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
    tags: ["v1", "v1.0"],
  });

  assert.deepEqual(result.updates, [
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0", action: "created", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["updateRef", "tags/v1", SHA, true],
    ["updateRef", "tags/v1.0", SHA, true],
    ["createRef", "refs/tags/v1.0", SHA],
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
