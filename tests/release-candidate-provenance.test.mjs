import assert from "node:assert/strict";
import test from "node:test";

import { selectMergedChannelPullRequest } from "../scripts/release-candidate-resolver.mjs";

const REPOSITORY = "kungfu-systems/buildchain";
const TARGET_REF = "alpha/v4/v4.0";
const TARGET_SHA = "2".repeat(40);
const common = {
  state: "closed",
  base: { ref: TARGET_REF, repo: { full_name: REPOSITORY } },
  head: { repo: { full_name: "dongkeren/buildchain" } },
  merge_commit_sha: TARGET_SHA,
};

test("release candidate provenance accepts an exact protected-base merge from a fork", () => {
  const selected = selectMergedChannelPullRequest({
    targetRef: TARGET_REF,
    targetSha: TARGET_SHA,
    repository: REPOSITORY,
    pullRequests: [
      { ...common, number: 3308, merged_at: "2026-08-30T02:41:11Z" },
    ],
  });
  assert.equal(selected.number, 3308);
});

test("release candidate provenance rejects unmerged, foreign-base, and stale merges", () => {
  const selected = selectMergedChannelPullRequest({
    targetRef: TARGET_REF,
    targetSha: TARGET_SHA,
    repository: REPOSITORY,
    pullRequests: [
      { ...common, number: 1 },
      {
        ...common,
        number: 2,
        merged_at: "2026-08-30T02:00:00Z",
        base: { ...common.base, repo: { full_name: "attacker/buildchain" } },
      },
      {
        ...common,
        number: 3,
        merged_at: "2026-08-30T02:01:00Z",
        merge_commit_sha: "3".repeat(40),
      },
    ],
  });
  assert.equal(selected, undefined);
});
