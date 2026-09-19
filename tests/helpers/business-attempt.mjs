import { createHash } from "node:crypto";
import { bindConsumerSource } from "../../packages/core/consumer/contract/identity.js";
import { readFileSync } from "node:fs";
import {
  pipelineIntent,
  sourceGeneration,
  businessAttempt,
} from "../../packages/core/workflow/attempt/identity.js";
import { attemptRecord } from "../../packages/core/workflow/attempt/records.js";
import { encodeRecord } from "../../packages/core/release/discussion/envelope.js";
import { businessAttemptStore } from "../../packages/core/workflow/attempt/store.js";

export const runtime = {
  repository: "kungfu-systems/buildchain",
  sha: "a".repeat(40),
  readerDigest: `sha256:${"b".repeat(64)}`,
};
export function identities(phases = ["admission", "build", "publish"]) {
  const intent = pipelineIntent({
    repository: "example/consumer",
    repositoryId: "R1",
    pullRequest: 23,
    targetBranch: "dev/v4/v4.1",
    phases,
    runtime,
  });
  const bytes = readFileSync(
    new URL(
      "../../templates/minimal-consumer/npm/.buildchain/buildchain.toml",
      import.meta.url,
    ),
  );
  const configBlob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const { identity: source } = bindConsumerSource(
    {
      repository: intent.repository,
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      configPath: ".buildchain/buildchain.toml",
      configBlob,
    },
    bytes,
  );
  const generation = sourceGeneration(intent, source, "e".repeat(40));
  const attempt = businessAttempt({
    intent,
    generation,
    requestKey: "pr-opened:delivery-id",
  });
  const writer = {
    repository: intent.repository,
    runId: "100",
    runAttempt: "1",
    jobId: "12",
  };
  const event = (previous = null, extra = {}) =>
    attemptRecord({
      intent,
      attempt,
      generation,
      writer,
      runtime,
      previous,
      eventKey: `event-${previous ? previous.sequence + 1 : 0}`,
      phase: previous ? "admission" : "attempt",
      state: "running",
      ...extra,
    });
  return { intent, source, generation, attempt, writer, event };
}

export function fixture() {
  const f = identities(),
    comments = [],
    author = { id: "BOT" };
  let discussion,
    lost = false,
    held = false,
    fences = 0,
    failFence = 0;
  const page = (nodes, cursor) => {
    const start = Number(cursor || 0),
      end = start + 2;
    return {
      nodes: nodes.slice(start, end),
      pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
    };
  };
  const transport = {
    repository: async () => ({
      id: "R1",
      viewer: author,
      discussionCategories: { nodes: [{ id: "CAT", name: "Announcements" }] },
    }),
    list: async () => page(discussion ? [discussion] : []),
    create: async ({ body }) => {
      discussion = {
        id: "D",
        url: "https://github.com/example/consumer/discussions/1",
        body,
        author,
        repository: { nameWithOwner: f.intent.repository },
      };
      if (lost) throw new Error("Lost create response");
      return discussion;
    },
    get: async () => discussion,
    comments: async (_id, cursor) =>
      page(
        comments.filter((c) => !c.replyTo),
        cursor,
      ),
    replies: async (id, cursor) =>
      page(
        comments.filter((c) => c.replyTo?.id === id),
        cursor,
      ),
    append: async (_id, body, parent) => {
      const id = String(comments.length + 1);
      const comment = {
        id,
        body,
        author,
        url: `https://github.com/example/consumer/discussions/1#discussioncomment-${id}`,
        replyTo: parent ? { id: parent } : null,
      };
      comments.push(comment);
      if (lost) throw new Error("Lost append response");
      return comment;
    },
  };
  const exclusive = {
    run: async (scope, operation) => {
      if (
        scope.repository !== f.intent.repository ||
        scope.intent !== f.intent.id ||
        held
      )
        throw new Error("Exclusive writer unavailable");
      held = true;
      try {
        return await operation({
          assertOwner: async () => {
            if (++fences === failFence) throw new Error("Writer fence expired");
          },
        });
      } finally {
        held = false;
      }
    },
  };
  const open = () =>
    businessAttemptStore(transport, exclusive, { sleep: async () => {} });
  return {
    ...f,
    transport,
    comments,
    open,
    encodeRecord,
    lose: () => {
      lost = true;
    },
    expire: (after) => {
      failFence = fences + after;
    },
  };
}
