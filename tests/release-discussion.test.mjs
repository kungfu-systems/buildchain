import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntent,
  createProgress,
  encodeRecord,
  decodeRecord,
} from "../packages/core/release/discussion/envelope.js";
import { readReleaseDiscussion } from "../packages/core/release/discussion/reader.js";
import { releaseDiscussionStore } from "../packages/core/release/discussion/store.js";
import { collectDiscussionPages } from "../packages/core/providers/github/discussions/transport.js";

const runtime = {
  repository: "kungfu-systems/buildchain",
  sha: "a".repeat(40),
  readerDigest: `sha256:${"b".repeat(64)}`,
};
const intent = createIntent({
  repository: "example/consumer",
  key: "4.1.3-alpha.0",
  expectedNodes: ["qualify", "publish", "settle"],
  source: { sha: "c".repeat(40) },
  runtime,
});
const progress = (node, status, extra = {}) =>
  createProgress({ intent, attempt: "100:1", runtime, node, status, ...extra });
const project = (records) =>
  readReleaseDiscussion({ body: encodeRecord(intent), records });

test("release completion requires the whole declared graph", () => {
  const records = [
    progress("qualify", "success"),
    progress("publish", "success"),
  ];
  assert.equal(project(records).status, "running");
  assert.deepEqual(project(records).missingNodes, ["settle"]);
  records.push(progress("settle", "success"));
  assert.equal(project(records).status, "complete");
  assert.equal(project([...records, records[0]]).status, "complete");
});

test("runtime recovery keeps intent and rejects stale-result completion", () => {
  const x = [progress("qualify", "success"), progress("publish", "failure")];
  const y = {
    attempt: "200:1",
    predecessor: "100:1",
    runtime: { ...runtime, sha: "d".repeat(40) },
  };
  const begin = progress("attempt", "running", y);
  assert.equal(project([...x, begin]).status, "running");
  assert.deepEqual(project([...x, begin]).missingNodes, intent.expectedNodes);
  const recovered = intent.expectedNodes.map((node) =>
    progress(node, "success", y),
  );
  const late = progress("settle", "failure");
  const result = project([begin, ...recovered, ...x, late]);
  assert.equal(result.status, "complete");
  assert.equal(result.intent.id, intent.id);
  assert.deepEqual(result.attempts, ["100:1", "200:1"]);
});

test("conflicting progress, sibling recoveries and missing predecessors fail closed", () => {
  assert.throws(
    () =>
      project([progress("publish", "success"), progress("publish", "failure")]),
    /Conflicting node/,
  );
  assert.throws(
    () =>
      project([
        progress("publish", "running", { sequence: 0 }),
        progress("publish", "success", { sequence: 1 }),
        progress("publish", "failure", { sequence: 0 }),
      ]),
    /Conflicting node/,
  );
  const x = progress("publish", "failure");
  const y = progress("attempt", "running", {
    attempt: "200:1",
    predecessor: "100:1",
  });
  const z = progress("attempt", "running", {
    attempt: "300:1",
    predecessor: "100:1",
  });
  assert.throws(() => project([x, y, z]), /ambiguous/);
  assert.throws(() => project([y]), /predecessor is missing/);
});

test("records are bounded and schema corruption is visible", () => {
  assert.equal(decodeRecord("ordinary human discussion"), undefined);
  assert.throws(
    () =>
      encodeRecord(
        progress("publish", "failure", {
          payload: { material: "x".repeat(50_000) },
        }),
      ),
    /bounded body/,
  );
  assert.throws(
    () => project([{ ...progress("publish", "success"), status: "failure" }]),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      createProgress({
        intent,
        attempt: "100:1",
        runtime,
        node: "unknown",
        status: "success",
      }),
    /Undeclared/,
  );
  assert.throws(
    () =>
      progress("publish", "success", { runtime: { ...runtime, sha: "v4" } }),
    /exact revision/,
  );
});

function provider() {
  const discussions = [];
  const comments = [];
  let loseCreate = false;
  let loseAppend = false;
  let writes = 0;
  const page = (nodes) => ({
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const transport = {
    async repository() {
      return {
        id: "repo",
        viewer: { id: "bot" },
        discussionCategories: {
          nodes: [{ id: "announcements", name: "Announcements" }],
        },
      };
    },
    async list() {
      return page(discussions);
    },
    async get(id) {
      return discussions.find((record) => record.id === id);
    },
    async comments() {
      return page(comments);
    },
    async create({ body }) {
      writes++;
      const record = {
        id: "discussion",
        body,
        author: { id: "bot" },
        repository: { nameWithOwner: intent.repository },
        url: "https://github.com/example/consumer/discussions/1",
      };
      discussions.push(record);
      if (loseCreate) throw new Error("lost create response");
      return record;
    },
    async append(id, body) {
      writes++;
      const record = {
        id: `comment-${comments.length}`,
        body,
        author: { id: "bot" },
      };
      comments.push(record);
      if (loseAppend) throw new Error("lost append response");
      return record;
    },
  };
  return {
    transport,
    discussions,
    comments,
    get writes() {
      return writes;
    },
    loseResponses() {
      loseCreate = true;
      loseAppend = true;
    },
  };
}

test("lost provider responses read back instead of repeating writes", async () => {
  const fake = provider();
  fake.loseResponses();
  const store = releaseDiscussionStore(fake.transport, {
    sleep: async () => {},
  });
  const session = await store.initialize({ intent });
  const event = progress("qualify", "success");
  await store.append(session, event);
  await store.append(session, event);
  const repeated = await store.initialize({ intent });
  assert.equal(repeated.discussion.id, session.discussion.id);
  assert.equal(fake.writes, 2);
});

test("preview has no provider calls or writes", async () => {
  const store = releaseDiscussionStore(
    new Proxy(
      {},
      {
        get() {
          throw new Error("unexpected provider call");
        },
      },
    ),
  );
  const session = await store.initialize({ intent, dryRun: true });
  assert.deepEqual(
    await store.append(session, progress("qualify", "success")),
    { dryRun: true },
  );
});

test("untrusted comments do not become transaction authority and edits are visible", async () => {
  const fake = provider();
  const store = releaseDiscussionStore(fake.transport);
  const session = await store.initialize({ intent });
  fake.comments.push({
    id: "outsider",
    author: { id: "outsider" },
    body: encodeRecord(progress("publish", "success")),
  });
  assert.equal((await store.read(session)).records.length, 0);
  fake.comments.push({
    id: "edited",
    author: { id: "bot" },
    body: encodeRecord(progress("publish", "success")),
    lastEditedAt: "2026-09-12",
  });
  await assert.rejects(store.read(session), /record was edited/);
});

test("incomplete pagination cannot be mistaken for missing transaction state", async () => {
  await assert.rejects(
    collectDiscussionPages(async () => ({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "same" },
    })),
    /did not advance/,
  );
});

test("checkpoint observations never substitute for successful semantic nodes", () => {
  const result = project([
    progress("publish", "running", {
      kind: "checkpoint",
      sequence: 12,
      payload: { state: "complete" },
    }),
  ]);
  assert.equal(result.status, "running");
  assert.deepEqual(result.missingNodes, intent.expectedNodes);
});

test("published historical reader operates under Node permission restrictions", async () => {
  const { spawnSync } = await import("node:child_process");
  const file = fileURLToPath(
    new URL("../dist/readers/release-discussion.cjs", import.meta.url),
  );
  const records = intent.expectedNodes.map((node) => progress(node, "success"));
  const result = spawnSync(
    process.execPath,
    ["--permission", `--allow-fs-read=${file}`, file],
    {
      input: JSON.stringify({ body: encodeRecord(intent), records }),
      encoding: "utf8",
      env: {},
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "complete");
});
