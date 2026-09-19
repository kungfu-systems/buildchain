import test from "node:test";
import assert from "node:assert/strict";
import { cancellationFixture } from "./helpers/pipeline-cancellation.mjs";
import { settlePipeline } from "../packages/core/workflow/pipeline/settlement.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

async function fixture() {
  const f = await cancellationFixture({ active: true });
  f.qualify();
  f.live.merged = true;
  const observed = await f.journal.read();
  const session = {
    intent: observed.intent,
    journal: f.journal,
    progress: f.ports.progress,
    observed,
  };
  const host = {
    repository: observed.intent.repository,
    materialStore: () => f.ports.materials,
    integration: {
      observe: async () => ({
        mergeCommit: "9".repeat(40),
        mergeTree: "8".repeat(40),
        build: { root: recordDigest("provider build fixture") },
        root: recordDigest("provider integration fixture"),
      }),
    },
    provider: { lookup: async () => null },
    wake: async () => {},
  };
  return { f, session, host, delivery: { service: f.ports.service } };
}

test("protected integration retains its exact proof before real Warrant settlement and completes the business attempt", async () => {
  const { f, session, host, delivery } = await fixture();
  const result = await settlePipeline(
    session,
    await f.observe(),
    delivery,
    host,
  );
  assert.equal(result.reason, "protected-delivery-settled");
  assert.equal(f.queue().activeWarrant, null);
  assert.equal((await f.journal.read()).status, "complete");
  const candidate = f
    .queue()
    .candidates.find((entry) => entry.pullRequestNumber === 23);
  assert.equal(candidate.status, "merged");
  assert.ok(
    (await f.journal.read()).materials[
      `merge/proof-${candidate.terminal.evidenceRoot.slice(7)}`
    ],
  );
});

test("a lost merged settlement response resumes from the retained integration proof without a second domain write", async () => {
  const { f, session, host, delivery } = await fixture();
  f.lose();
  await assert.rejects(
    settlePipeline(session, await f.observe(), delivery, host),
    /Response lost/,
  );
  assert.equal(f.queue().activeWarrant, null);
  assert.equal((await f.journal.read()).status, "waiting");
  const writes = f.writes();
  await settlePipeline(session, await f.observe(), delivery, host);
  assert.equal(f.writes(), writes);
  assert.equal((await f.journal.read()).status, "complete");
});
