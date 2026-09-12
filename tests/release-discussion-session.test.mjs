import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { executeReleaseDiscussion } from "../packages/core/release/discussion/qualification.js";

function provider() {
  let discussion;
  const comments = [];
  const author = { login: "github-actions[bot]", id: "BOT" };
  const page = (nodes) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const graphql = async (query, variables) => {
    if (query.includes("discussionCategories"))
      return {
        viewer: author,
        repository: {
          id: "REPO",
          hasDiscussionsEnabled: true,
          discussionCategories: {
            nodes: [{ id: "ANNOUNCEMENTS", name: "Announcements" }],
          },
        },
      };
    if (query.includes("CreateDiscussionInput")) {
      assert.equal(variables.input.categoryId, "ANNOUNCEMENTS");
      assert.equal(discussion, undefined, "intent must never be created twice");
      discussion = {
        id: "DISCUSSION",
        number: 1,
        url: "https://github.com/example/consumer/discussions/1",
        body: variables.input.body,
        author,
        repository: { nameWithOwner: "example/consumer" },
      };
      return { createDiscussion: { discussion } };
    }
    if (query.includes("AddDiscussionCommentInput")) {
      assert.equal(variables.input.discussionId, discussion.id);
      const comment = {
        id: String(comments.length + 1),
        body: variables.input.body,
        author,
      };
      comments.push(comment);
      return { addDiscussionComment: { comment } };
    }
    if (query.includes("comments(first"))
      return { node: { comments: page(comments) } };
    if (query.includes("discussions(first"))
      return {
        repository: { discussions: page(discussion ? [discussion] : []) },
      };
    if (query.includes("node(id")) return { node: discussion };
    throw new Error("Unimplemented provider query");
  };
  return {
    graphql,
    comments,
    get discussion() {
      return discussion;
    },
  };
}

const runtimeRoot = path.resolve(import.meta.dirname, "..");
function context(fake, runId, sha) {
  return {
    octokit: { graphql: fake.graphql },
    runtimeRoot,
    runId,
    runAttempt: "1",
    runtimeSelection: JSON.stringify({
      repository: "kungfu-systems/buildchain",
      sha,
    }),
  };
}
function request(payload) {
  return {
    consumer: { repository: "example/consumer" },
    capability: { permissions: { discussions: "write" } },
    payload: { schema: "buildchain.release-discussion-request/v1", ...payload },
  };
}

test("consumer Bootstrap qualification switches exact runtime in the same Discussion", async () => {
  const fake = provider();
  await assert.rejects(
    executeReleaseDiscussion(
      request({
        operation: "qualify",
        key: "runtime-recovery",
        outcome: "failure",
      }),
      {},
      context(fake, "100", "a".repeat(40)),
    ),
    /Injected Discussion qualification failure/,
  );
  const first = {
    status: "failed",
    discussionId: fake.discussion.id,
    attempt: "100:1",
    runtime: { sha: "a".repeat(40) },
  };
  const body = fake.discussion.body;
  const oldComments = fake.comments.map((comment) => ({ ...comment }));
  const recovered = await executeReleaseDiscussion(
    request({
      operation: "qualify",
      key: "runtime-recovery",
      outcome: "success",
      discussionId: first.discussionId,
      predecessor: first.attempt,
    }),
    {},
    context(fake, "200", "b".repeat(40)),
  );
  assert.equal(recovered.status, "complete");
  assert.equal(recovered.discussionId, first.discussionId);
  assert.notEqual(first.runtime.sha, recovered.runtime.sha);
  assert.equal(fake.discussion.body, body);
  assert.deepEqual(fake.comments.slice(0, oldComments.length), oldComments);
  const view = await executeReleaseDiscussion(
    request({ operation: "inspect", discussionId: first.discussionId }),
    {},
    context(fake, "300", "b".repeat(40)),
  );
  assert.deepEqual(view.attempts, ["100:1", "200:1"]);
  const count = fake.comments.length;
  await assert.rejects(
    executeReleaseDiscussion(
      request({
        operation: "qualify",
        key: "runtime-recovery",
        outcome: "success",
        discussionId: first.discussionId,
        predecessor: first.attempt,
      }),
      {},
      context(fake, "400", "c".repeat(40)),
    ),
    /requires predecessor/,
  );
  assert.equal(fake.comments.length, count);
});

test("qualification requires an explicit consumer permission and closed request", async () => {
  const fake = provider();
  const input = request({
    operation: "qualify",
    key: "permission",
    outcome: "success",
  });
  input.capability.permissions = { discussions: "read" };
  await assert.rejects(
    executeReleaseDiscussion(input, {}, context(fake, "100", "a".repeat(40))),
    /discussions: write/,
  );
  const unknown = request({
    operation: "qualify",
    key: "permission",
    outcome: "success",
    extra: true,
  });
  await assert.rejects(
    executeReleaseDiscussion(unknown, {}, context(fake, "100", "a".repeat(40))),
    /Unknown/,
  );
  assert.equal(fake.discussion, undefined);
});

test("independent binary workflow joins intent and a late result stays on the superseded attempt", async () => {
  const { openReleaseSession } =
    await import("../packages/core/release/discussion/session.js");
  const { observeBinaryDistribution } =
    await import("../packages/core/release/discussion/binary.js");
  const fake = provider();
  const runtime = {
    repository: "kungfu-systems/buildchain",
    sha: "a".repeat(40),
    readerDigest: `sha256:${"b".repeat(64)}`,
  };
  const inputs = {
    graphql: fake.graphql,
    repository: "example/consumer",
    key: "4.1.3-alpha.0",
    source: { version: "4.1.3-alpha.0" },
    expectedNodes: ["publication", "binary-distribution"],
    runtime,
    attempt: "100:1",
  };
  const first = await openReleaseSession(inputs);
  await first.record("publication", "success");
  assert.equal((await first.read()).status, "running");
  const locator = {
    schema: "buildchain.release-locator/v1",
    repository: inputs.repository,
    version: inputs.key,
    intent: first.session.intent.id,
    discussionId: fake.discussion.id,
  };
  const options = {
    client: {
      release: async () => ({
        assets: [{ name: "buildchain.release-transaction.json" }],
      }),
      assetBytes: () => JSON.stringify(locator),
    },
    octokit: { graphql: fake.graphql },
    repository: inputs.repository,
    tag: `v${inputs.key}`,
    runtime,
    writer: "200:1:binary",
  };
  let next;
  await observeBinaryDistribution(options, async () => {
    next = await openReleaseSession({
      ...inputs,
      attempt: "300:1",
      runtime: { ...runtime, sha: "c".repeat(40) },
      predecessor: "100:1",
      discussionId: fake.discussion.id,
    });
    await next.record("publication", "success");
    return { assets: [1, 2, 3] };
  });
  assert.equal((await next.read()).status, "running");
  await observeBinaryDistribution(
    {
      ...options,
      writer: "400:1:binary",
      runtime: { ...runtime, sha: "d".repeat(40) },
    },
    async () => ({ assets: [1, 2, 3] }),
  );
  assert.equal((await next.read()).status, "complete");
});
