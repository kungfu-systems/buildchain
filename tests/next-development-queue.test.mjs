import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNextDevelopmentPull,
  enqueueNextDevelopmentPullRequest,
  nextDevelopmentQueueFailure,
} from "../actions/v4-release-candidate-promote/next-development-queue.js";

const headSha = "a".repeat(40);
async function queue(errors, options = {}) {
  const waits = [],
    requests = [];
  await enqueueNextDevelopmentPullRequest({
    pull: { node_id: "PR_exact" },
    headSha,
    mutationOctokit: {
      graphql: async (_query, variables) => {
        requests.push(variables);
        const error = errors.shift();
        if (error) throw error;
      },
    },
    wait: async (delay) => waits.push(delay),
    ...options,
  });
  return { waits, requests };
}

test("queue retries pending and transient errors while binding the original exact head", async () => {
  const result = await queue([
    new Error("mergeability check has not yet completed"),
    Object.assign(new Error("unavailable"), { status: 503 }),
    new Error("Required status check Verify expected"),
  ]);
  assert.deepEqual(result.waits, [2000, 4000, 6000]);
  for (const request of result.requests)
    assert.deepEqual(request.input, {
      pullRequestId: "PR_exact",
      expectedHeadOid: headSha,
    });
});

test("pending and transport retry budgets are bounded; permissions and conflicts fail immediately", async () => {
  await assert.rejects(
    queue(
      Array.from(
        { length: 4 },
        () => new Error("mergeability check has not yet completed"),
      ),
      { maxPolls: 2 },
    ),
  );
  await assert.rejects(
    queue(
      Array.from({ length: 6 }, () =>
        Object.assign(new Error("unavailable"), { status: 503 }),
      ),
    ),
  );
  for (const status of [401, 403, 404, 409, 422]) {
    const error = Object.assign(
      new Error("permission or exact-head conflict"),
      { status },
    );
    assert.equal(nextDevelopmentQueueFailure(error), "rejected");
    await assert.rejects(queue([error]));
  }
});

test("duplicate enqueue and already merged responses still require exact terminal PR readback", async () => {
  for (const message of [
    "Pull request already in queue",
    "Pull request already merged",
  ])
    assert.equal((await queue([new Error(message)])).requests.length, 1);
  const pull = {
    head: { sha: headSha },
    base: { ref: "dev/v4/v4.0" },
    state: "closed",
    merged_at: "2026-09-05T00:00:00Z",
  };
  assertNextDevelopmentPull(pull, headSha, "dev/v4/v4.0");
  assert.throws(() =>
    assertNextDevelopmentPull(
      { ...pull, head: { sha: "b".repeat(40) } },
      headSha,
      "dev/v4/v4.0",
    ),
  );
  assert.throws(() =>
    assertNextDevelopmentPull(
      { ...pull, merged_at: null },
      headSha,
      "dev/v4/v4.0",
    ),
  );
  assert.throws(() =>
    assertNextDevelopmentPull(pull, headSha, "release/v4/v4.0"),
  );
});
