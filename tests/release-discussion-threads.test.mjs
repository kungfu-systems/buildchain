import assert from "node:assert/strict";
import test from "node:test";
import {
  createIntent,
  createProgress,
  encodeRecord,
  decodeRecord,
} from "../packages/core/release/discussion/envelope.js";
import { releaseDiscussionStore } from "../packages/core/release/discussion/store.js";
import { renderEvent } from "../packages/core/release/discussion/presentation.js";
import {
  diagnosticReport,
  diagnosticLog,
} from "../packages/core/release/discussion/evidence.js";

const runtime = {
  repository: "example/buildchain",
  sha: "a".repeat(40),
  readerDigest: `sha256:${"b".repeat(64)}`,
};
const intent = createIntent({
  repository: "example/consumer",
  key: "1.2.3-alpha.1",
  source: {},
  expectedNodes: ["publication", "settlement"],
  runtime,
});
function fixture() {
  const comments = [];
  let lost = false,
    reads = 0;
  const author = { id: "BOT" };
  const discussion = {
    id: "D",
    body: encodeRecord(intent),
    author,
    repository: { nameWithOwner: intent.repository },
  };
  const session = { discussion, intent, writerId: author.id };
  const page = (nodes, cursor) => {
    reads++;
    const start = Number(cursor || 0),
      end = start + 2;
    return {
      nodes: nodes.slice(start, end),
      pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
    };
  };
  const transport = {
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
      const id = `C${comments.length}`;
      const comment = {
        id,
        body,
        author,
        url: `https://github.com/example/consumer/discussions/1#discussioncomment-${id}`,
        replyTo: parent ? { id: parent } : null,
      };
      comments.push(comment);
      if (lost) throw new Error("Response lost after commit");
      return comment;
    },
  };
  const store = releaseDiscussionStore(transport, { sleep: async () => {} });
  const event = (node, status, extra = {}) =>
    createProgress({
      intent,
      runtime,
      attempt: "100:1",
      node,
      status,
      ...extra,
    });
  return {
    store,
    session,
    comments,
    event,
    transport,
    lose: () => {
      lost = true;
    },
    reads: () => reads,
  };
}

test("roots and their complete reply pages survive retries and cross-runtime recovery", async () => {
  const f = fixture();
  f.lose();
  const root = await f.store.append(f.session, f.event("attempt", "running"));
  for (let sequence = 0; sequence < 7; sequence++) {
    const event = f.event("publication", "running", {
      kind: "checkpoint",
      sequence,
    });
    await f.store.append(f.session, event);
    await f.store.append(f.session, event);
  }
  await f.store.append(f.session, f.event("publication", "success"));
  assert.equal(f.comments.filter((c) => !c.replyTo).length, 1);
  assert.ok(f.comments.slice(1).every((c) => c.replyTo.id === root.id));
  const original = structuredClone(f.comments);
  const successor = {
    attempt: "200:1",
    predecessor: "100:1",
    runtime: { ...runtime, sha: "c".repeat(40) },
  };
  const next = await f.store.append(
    f.session,
    f.event("attempt", "running", successor),
  );
  assert.match(next.body, new RegExp(root.url));
  await f.store.append(f.session, f.event("publication", "success", successor));
  // Independent workflow finishes the old attempt after recovery already began.
  await f.store.append(
    f.session,
    f.event("settlement", "success", { writer: "300:1:binary" }),
  );
  assert.equal(f.comments.at(-1).replyTo.id, root.id);
  assert.equal((await f.store.read(f.session)).status, "running");
  await f.store.append(
    f.session,
    f.event("settlement", "success", { ...successor, writer: "400:1:binary" }),
  );
  assert.equal(f.comments.at(-1).replyTo.id, next.id);
  assert.equal((await f.store.read(f.session)).status, "complete");
  assert.deepEqual(f.comments.slice(0, original.length), original);
  assert.equal(f.comments.filter((c) => !c.replyTo).length, 2);
  assert.ok(f.reads() > 10);
});

test("orphan events, duplicate roots, wrong parents and edited replies cannot become authority", async () => {
  const f = fixture();
  await assert.rejects(
    f.store.append(f.session, f.event("publication", "success")),
    /Open the attempt root/,
  );
  const root = await f.store.append(f.session, f.event("attempt", "running"));
  await assert.rejects(
    f.store.append(
      f.session,
      f.event("attempt", "running", { payload: { changed: true } }),
    ),
    /Conflicting node|root already exists/,
  );
  const reply = await f.store.append(
    f.session,
    f.event("publication", "success"),
  );
  reply.replyTo = null;
  await assert.rejects(f.store.read(f.session), /attempt root reply/);
  reply.replyTo = { id: root.id };
  reply.lastEditedAt = "2026-09-12";
  await assert.rejects(f.store.read(f.session), /record was edited/);
  delete reply.lastEditedAt;
  f.comments.push({ ...root, id: "duplicate" });
  await assert.rejects(f.store.read(f.session), /Ambiguous/);
});

test("transaction-shaped replies under a human thread are rejected but ordinary conversation is ignored", async () => {
  const f = fixture();
  await f.store.append(f.session, f.event("attempt", "running"));
  f.comments.push({ id: "human", body: "Question", author: { id: "human" } });
  f.comments.push({
    id: "answer",
    body: "Ordinary answer",
    author: { id: "BOT" },
    replyTo: { id: "human" },
  });
  assert.equal((await f.store.read(f.session)).records.length, 1);
  f.comments.at(-1).body = encodeRecord(f.event("publication", "success"));
  await assert.rejects(f.store.read(f.session), /different attempt root/);
});

test("historical flat bytes remain readable while a new attempt uses its own thread", async () => {
  const f = fixture();
  const { organization, ...historical } = intent;
  f.session.intent = historical;
  f.session.discussion.body = encodeRecord(historical);
  await f.transport.append("D", encodeRecord(f.event("attempt", "running")));
  await f.transport.append(
    "D",
    encodeRecord(f.event("publication", "failure")),
  );
  const original = structuredClone(f.comments);
  const extra = { attempt: "200:1", predecessor: "100:1" };
  const root = await f.store.append(
    f.session,
    f.event("attempt", "running", extra),
  );
  await f.store.append(f.session, f.event("publication", "success", extra));
  assert.equal(f.comments.at(-1).replyTo.id, root.id);
  assert.deepEqual(f.comments.slice(0, 2), original);
  assert.equal((await f.store.read(f.session)).attempt, "200:1");
});

test("events expose evidence and writer context without unsafe Markdown links", () => {
  const payload = {
    label: "Sealed candidate evidence",
    attachments: [
      {
        name: "candidate.json",
        mediaType: "application/json",
        size: 120,
        digest: `sha256:${"a".repeat(64)}`,
        downloadUrl:
          "https://github.com/example/consumer/releases/download/untagged-evidence/candidate.json",
      },
    ],
    details: "</pre><script>malicious</script>",
  };
  const f = fixture();
  const record = f.event("publication", "running", {
    kind: "checkpoint",
    payload,
  });
  const body = renderEvent(record, intent, { roots: new Map() });
  assert.match(body, /publication · checkpoint 0/);
  assert.match(
    body,
    /\[candidate.json\]\(https:\/\/github.com\/example\/consumer\/releases\/download\//,
  );
  assert.match(body, /actions\/runs\/100\/attempts\/1/);
  assert.doesNotMatch(body, /<script>/);
  payload.attachments[0].downloadUrl = "https://evil.example/secret";
  assert.throws(() => renderEvent(record, intent, {}), /consumer repository/);
});

test("diagnostic logs retain only declared context, never raw payloads or exception secrets", () => {
  const f = fixture();
  const record = f.event("publication", "failure", {
    payload: { authorization: "PRIVATE" },
  });
  const report = diagnosticReport(
    { intent, attempt: "100:1" },
    { records: [record] },
    "publication",
    "publish-failed",
  );
  const log = diagnosticLog(report).toString();
  assert.match(log, /publication progress 0 failure writer=100:1/);
  assert.doesNotMatch(JSON.stringify(report) + log, /PRIVATE|authorization/);
  assert.equal(
    decodeRecord(encodeRecord(record)).payload.authorization,
    "PRIVATE",
  );
});
