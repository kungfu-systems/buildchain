import assert from "node:assert/strict";
import test from "node:test";
import {
  enqueueNextDevelopmentPullRequest,
  nextDevelopmentQueueFailure,
} from "../packages/core/release/promote-candidate/next-development-queue.js";

const headSha = "a".repeat(40);
const message =
  "Something went wrong while executing your query on 2026-09-11T18:09:47Z. Please include `8420:133452:B1068:243FB9:6AA443EA` when reporting this issue.";
const internal = () =>
  Object.assign(
    new Error(
      `Request failed due to following response errors:\n - ${message}`,
    ),
    { errors: [{ message }] },
  );
const node = {
  id: "PR_exact",
  headRefOid: headSha,
  baseRefName: "dev/v4/v4.1",
  state: "OPEN",
  merged: false,
  mergeQueueEntry: { id: "queue_entry", state: "AWAITING_CHECKS" },
};

async function enqueue({
  mutationError = internal,
  observation = node,
  observationError,
  maxPolls = 10,
} = {}) {
  const calls = { mutations: 0, reads: 0, waits: [] };
  const run = enqueueNextDevelopmentPullRequest({
    pull: { node_id: "PR_exact", base: { ref: "dev/v4/v4.1" } },
    headSha,
    maxPolls,
    mutationOctokit: {
      graphql: async (query, variables) => {
        if (query.startsWith("query")) {
          calls.reads++;
          assert.deepEqual(variables, { id: "PR_exact" });
          if (observationError) throw observationError;
          return { node: observation };
        }
        calls.mutations++;
        assert.deepEqual(variables.input, {
          pullRequestId: "PR_exact",
          expectedHeadOid: headSha,
        });
        const error = mutationError(calls.mutations);
        if (error) throw error;
      },
    },
    wait: async (delay) => calls.waits.push(delay),
  });
  return { run, calls };
}

test("GitHub internal response after accepted enqueue recovers by exact queue readback", async () => {
  for (const observation of [
    node,
    { ...node, state: "MERGED", merged: true, mergeQueueEntry: null },
  ]) {
    const { run, calls } = await enqueue({ observation });
    await run;
    assert.deepEqual(calls, { mutations: 1, reads: 1, waits: [] });
  }
});

test("unobserved internal failures retry within the existing transport budget", async () => {
  const { run, calls } = await enqueue({
    observation: { ...node, mergeQueueEntry: null },
  });
  await assert.rejects(run, (error) => error.releaseTailClass === "transient");
  assert.equal(calls.mutations, 5);
  assert.equal(calls.reads, 5);
  assert.deepEqual(calls.waits, [2000, 4000, 6000, 8000]);
  const recovered = await enqueue({
    observationError: Object.assign(new Error("unavailable"), { status: 503 }),
    mutationError: (count) => (count === 1 ? internal() : null),
  });
  await recovered.run;
  assert.deepEqual(recovered.calls, { mutations: 2, reads: 1, waits: [2000] });
});

test("ambiguous enqueue cannot accept changed identity, closed PRs or unreadable authority", async () => {
  for (const observation of [
    null,
    { ...node, id: "PR_other" },
    { ...node, headRefOid: "b".repeat(40) },
    { ...node, baseRefName: "release/v4/v4.1" },
    { ...node, state: "CLOSED", mergeQueueEntry: null },
  ]) {
    const { run, calls } = await enqueue({ observation });
    await assert.rejects(run, (error) => error.releaseTailClass === "conflict");
    assert.deepEqual(calls, { mutations: 1, reads: 1, waits: [] });
  }
  const denied = await enqueue({
    observationError: Object.assign(new Error("forbidden"), { status: 403 }),
  });
  await assert.rejects(
    denied.run,
    (error) => error.releaseTailClass === "conflict",
  );
  assert.equal(denied.calls.mutations, 1);
});

test("authority and mixed GraphQL failures are rejected without a success readback", async () => {
  for (const error of [
    Object.assign(internal(), { status: 403 }),
    Object.assign(new Error("mixed errors"), {
      errors: [{ message }, { type: "FORBIDDEN", message: "not permitted" }],
    }),
    Object.assign(new Error("validation"), {
      errors: [{ type: "UNPROCESSABLE", message: "expected head differs" }],
    }),
  ]) {
    assert.equal(nextDevelopmentQueueFailure(error), "rejected");
    const { run, calls } = await enqueue({ mutationError: () => error });
    await assert.rejects(run);
    assert.deepEqual(calls, { mutations: 1, reads: 0, waits: [] });
  }
});
