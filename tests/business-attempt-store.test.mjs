import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/business-attempt.mjs";
import {
  businessAttempt,
  sourceGeneration,
} from "../packages/core/workflow/attempt/identity.js";
import { businessAttemptStore } from "../packages/core/workflow/attempt/store.js";

test("Discussion lost responses, duplicate delivery and process restart retain one immutable journal", async () => {
  const f = fixture();
  f.lose();
  let store = f.open();
  const session = await store.initialize({ intent: f.intent });
  const again = await store.initialize({ intent: f.intent });
  assert.equal(again.discussion.id, session.discussion.id);
  const root = f.event();
  await store.append(session, root, "");
  await store.append(session, root, "");
  let head = root;
  for (const phase of f.intent.expectedNodes) {
    head = f.event(head, { phase, state: "success" });
    await store.append(session, head, head.payload.previous);
  }
  store = f.open();
  assert.equal((await store.read(session)).status, "complete");
  assert.equal(f.comments.length, 4);
  assert.equal(f.comments.filter((c) => !c.replyTo).length, 1);
});

test("expected head and current attempt fence late writers across recovery", async () => {
  const f = fixture(),
    store = f.open();
  const session = await store.initialize({ intent: f.intent }),
    root = f.event();
  await store.append(session, root, "");
  const accepted = f.event(root, { state: "success" });
  await assert.rejects(
    store.append(session, accepted, ""),
    /Stale attempt head/,
  );
  await store.append(session, accepted, root.id);
  const history = JSON.stringify(f.comments);
  const generation = sourceGeneration(f.intent, f.source, "f".repeat(40));
  const attempt = businessAttempt({
    intent: f.intent,
    generation,
    predecessor: f.attempt.id,
    requestKey: "base-drift",
  });
  const retry = f.event(null, { attempt, generation });
  await store.append(session, retry, accepted.id);
  const late = f.event(accepted, { phase: "build", state: "success" });
  await assert.rejects(
    store.append(session, late, retry.id),
    /superseded attempt/,
  );
  const wrong = businessAttempt({ ...f, requestKey: "missing-predecessor" });
  await assert.rejects(
    store.append(session, f.event(null, { attempt: wrong }), retry.id),
    /succeed the current attempt/,
  );
  assert.equal(JSON.stringify(f.comments.slice(0, 2)), history);
  assert.equal((await store.read(session)).status, "running");
});

test("lost provider fence and concurrent mutations stop before append", async () => {
  const f = fixture(),
    store = f.open();
  const session = await store.initialize({ intent: f.intent }),
    root = f.event();
  f.expire(3); // scope admission, pre-append and the actual transport mutation
  await assert.rejects(store.append(session, root, ""), /outcome is unknown/);
  assert.equal(f.comments.length, 0);
  const results = await Promise.allSettled([
    store.append(session, root, ""),
    store.append(session, root, ""),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.comments.length, 1);
  assert.throws(
    () => businessAttemptStore(f.transport),
    /exclusive provider writer/,
  );
});

test("trusted repository and author readback rejects replacements and edited evidence", async () => {
  const f = fixture(),
    store = f.open();
  await assert.rejects(
    store.initialize({
      intent: {
        ...f.intent,
        source: { ...f.intent.source, repositoryId: "RENAMED" },
      },
    }),
    /repository identity/,
  );
  const session = await store.initialize({ intent: f.intent });
  await store.append(session, f.event(), "");
  f.comments[0].lastEditedAt = "2026-09-12";
  await assert.rejects(store.read(session), /record was edited/);
  delete f.comments[0].lastEditedAt;
  f.comments[0].author = { id: "ATTACKER" };
  assert.equal((await store.read(session)).status, "pending");
  assert.equal((await store.read(session)).attempt, "");
});
