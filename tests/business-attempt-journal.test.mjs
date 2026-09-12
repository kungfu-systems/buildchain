import test from "node:test";
import assert from "node:assert/strict";
import {
  atomicAttemptJournal,
  journalSnapshot,
} from "../packages/core/workflow/attempt/journal.js";
import { identities } from "./helpers/business-attempt.mjs";

function providerFixture() {
  let current = null,
    sequence = 0,
    lose = false;
  const provider = {
    read: async () => structuredClone(current),
    append: async ({ snapshot, expectedCommit }) => {
      if ((current?.commit || "") !== expectedCommit)
        throw new Error("Non-fast-forward provider update");
      current = {
        commit: String(++sequence),
        snapshot: structuredClone(snapshot),
      };
      if (lose) throw new Error("Response lost after commit");
    },
  };
  return {
    provider,
    lose: () => {
      lose = true;
    },
  };
}

test("atomic journal fences competing writers and reconciles a lost response", async () => {
  const f = identities(),
    fixture = providerFixture();
  const journal = atomicAttemptJournal(fixture.provider, f.intent);
  const root = f.event();
  fixture.lose();
  await journal.append(root, "");
  const a = f.event(root, { state: "waiting", reason: "approval pending" });
  const b = f.event(root, { state: "success", eventKey: "competing" });
  const results = await Promise.allSettled([
    journal.append(a, root.id),
    journal.append(b, root.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /Non-fast-forward/,
  );
  const restarted = atomicAttemptJournal(fixture.provider, f.intent);
  const state = await restarted.read();
  assert.equal(state.snapshot.records.length, 2);
  assert.equal(state.head, a.id);
  assert.equal((await restarted.append(a, root.id)).head, a.id);
  await assert.rejects(
    restarted.append({ ...a, node: "build" }, root.id),
    /Conflicting/,
  );
  await assert.rejects(restarted.append(b, root.id), /Stale attempt head/);
});

test("journal cannot admit corrupt history or an uncompleted predecessor", async () => {
  const f = identities(),
    fixture = providerFixture();
  const journal = atomicAttemptJournal(fixture.provider, f.intent);
  const root = f.event();
  await journal.append(root, "");
  await assert.rejects(
    journal.append(f.event(root, { phase: "build" }), root.id),
    /predecessor/,
  );
  const corrupt = journalSnapshot(f.intent, [root]);
  corrupt.records = [];
  const reader = atomicAttemptJournal(
    { read: async () => ({ commit: "x", snapshot: corrupt }) },
    f.intent,
  );
  await assert.rejects(reader.read(), /content root drift/);
});
