import test from "node:test";
import assert from "node:assert/strict";
import { githubAttemptIndex } from "../packages/core/providers/github/attempt-index.js";
import { journalSnapshot } from "../packages/core/workflow/attempt/journal.js";
import { identities } from "./helpers/business-attempt.mjs";

test("business selector index resolves through current authority and reconciles lost create response", async () => {
  const f = identities(),
    first = "a".repeat(40),
    second = "b".repeat(40),
    orphan = "c".repeat(40);
  const initial = f.event();
  const versions = new Map([
    [first, { commit: first, snapshot: journalSnapshot(f.intent, [initial]) }],
    [
      second,
      {
        commit: second,
        snapshot: journalSnapshot(f.intent, [
          initial,
          f.event(initial, { state: "success" }),
        ]),
      },
    ],
    [
      orphan,
      {
        commit: orphan,
        snapshot: journalSnapshot(f.intent, [
          f.event(null, { eventKey: "unadmitted-root" }),
        ]),
      },
    ],
  ]);
  let pointer,
    current = first;
  const provider = {
    read: async () => versions.get(current),
    readCommit: async (repository, sha) => {
      assert.equal(repository, f.intent.repository);
      return versions.get(sha);
    },
  };
  const request = async (_url, { method, body } = {}) => {
    if (method === "POST") {
      if (pointer) throw new Error("Reference already exists");
      pointer = body.sha;
      throw new Error("Lost response");
    }
    return pointer ? { object: { sha: pointer } } : undefined;
  };
  const index = githubAttemptIndex(request, provider, f.intent.repository);
  await index.retain(f.intent, f.attempt.id);
  current = second;
  assert.equal((await index.resolve(f.attempt.id)).commit, second);
  assert.equal((await index.retain(f.intent, f.attempt.id)).commit, second);
  assert.equal(pointer, first);
  pointer = orphan;
  await assert.rejects(
    index.resolve(f.attempt.id),
    /absent from the authoritative journal/,
  );
});
