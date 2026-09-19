import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { signedPublicationFixture } from "./helpers/pipeline-publication-signed.mjs";
import { publicationApplyProvider } from "./helpers/pipeline-publication-apply-provider.mjs";
import { publicationSuccessor } from "./helpers/pipeline-publication-successor.mjs";
import { applyPipelinePublication } from "../packages/core/publication/pipeline/apply.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

async function appendPublisherDrift(f, mutate = () => {}) {
  const plan = structuredClone(f.context.plan);
  plan.publisher.workflowSha = "8".repeat(40);
  const materialization = structuredClone(f.context.materialization);
  mutate(plan, materialization);
  const { root: oldPlan, ...body } = plan;
  plan.root = recordDigest(body);
  materialization.planRoot = plan.root;
  const { root: oldSource, ...source } = materialization;
  materialization.root = recordDigest(source);
  await f.journal.record("publication/plan", plan);
  await f.journal.record("publication/materialization", materialization);
  return { plan, materialization };
}

test("signed lineage recovers an unsigned publisher rederivation without replacing any product or historical record", async (t) => {
  const f = await signedPublicationFixture(t);
  const stale = await appendPublisherDrift(f);
  const before = structuredClone(f.f.snapshot().records);
  const successor = await publicationSuccessor(f, f.session, 300);
  assert.deepEqual(successor.context.plan, f.context.plan);
  assert.deepEqual(
    successor.context.materialization,
    f.context.materialization,
  );
  assert.equal(successor.context.recovery.preserveTransaction, true);
  assert.deepEqual(await successor.journal.materials("publication/plan/"), [
    f.context.plan,
  ]);
  assert.deepEqual(
    await successor.journal.materials("publication/predecessor-plan/"),
    [stale.plan],
  );
  assert.deepEqual(f.f.snapshot().records.slice(0, before.length), before);
  const { state, npmProvider } = publicationApplyProvider(f.host);
  state.failAsset = false;
  const result = await applyPipelinePublication(
    successor.context,
    f.host,
    path.join(f.root, "publisher-drift"),
    {},
    { verifySigning: f.verifySigning, npmProvider },
  );
  assert.equal(
    result.release.receipt.transactionRoot,
    f.retained.documents.transaction.transactionRoot,
  );
  assert.equal(state.writes.filter((value) => value === "npm").length, 1);
  assert.deepEqual(
    (await successor.journal.materials("publication/qualified/"))[0],
    f.retained,
  );
});

test("signed plan selection rejects source and runtime drift in conflicting records", async (t) => {
  for (const mutate of [
    (plan) => {
      plan.runtime.commit = "7".repeat(40);
    },
    (plan, materialization) => {
      materialization.source.commit = "7".repeat(40);
    },
  ]) {
    const f = await signedPublicationFixture(t);
    await appendPublisherDrift(f, mutate);
    await assert.rejects(
      publicationSuccessor(f, f.session, 300),
      /Conflicting recovery|one exact retained material/,
    );
  }
});

test("expired signed publication survives partial npm success, a second recovery and lost asset responses with its original transaction", async (t) => {
  const f = await signedPublicationFixture(t);
  const { state, npmProvider } = publicationApplyProvider(f.host);
  const ports = { verifySigning: f.verifySigning, npmProvider };
  await assert.rejects(
    applyPipelinePublication(
      f.context,
      f.host,
      path.join(f.root, "expired"),
      {},
      ports,
    ),
    /freshness window/,
  );
  assert.deepEqual(state.writes, []);
  const original = structuredClone(f.retained);
  const first = await publicationSuccessor(f, f.session, 300);
  assert.equal(first.operation, "apply");
  assert.equal(first.context.recovery.preserveTransaction, true);
  assert.notEqual(
    first.context.recovery.execution.runtime.commit,
    f.context.plan.runtime.commit,
  );
  await assert.rejects(
    applyPipelinePublication(
      first.context,
      f.host,
      path.join(f.root, "partial"),
      {},
      ports,
    ),
    /upload unavailable/,
  );
  assert.equal(state.writes.filter((value) => value === "npm").length, 1);
  const completed = (
    await first.journal.materials("publication/effect/")
  ).filter((receipt) => receipt.state === "success");
  assert.equal(completed.length, 2);
  assert.equal(
    (await first.session.journal.read()).phases.publish.payload.state,
    "running",
  );
  const second = await publicationSuccessor(f, first.session, 400);
  state.failAsset = false;
  const complete = await applyPipelinePublication(
    second.context,
    f.host,
    path.join(f.root, "complete"),
    {},
    ports,
  );
  assert.equal(complete.release.receipt.outcome, "complete");
  assert.equal(state.writes.filter((value) => value === "npm").length, 1);
  assert.equal(state.writes.filter((value) => value === "tag").length, 1);
  assert.equal(state.release.draft, false);
  const retained = (
    await second.journal.materials("publication/qualified/")
  )[0];
  assert.deepEqual(retained, original);
  const receipts = await second.journal.materials("publication/effect/");
  for (const receipt of completed)
    assert.ok(receipts.some((item) => item.root === receipt.root));
  const authority = await second.journal.materials(
    "publication/recovery-authorization/",
  );
  assert.ok(
    Date.parse(authority.at(-1).admission.qualification.expiresAt) > Date.now(),
  );
  assert.equal(
    authority.at(-1).admission.originalDocumentsRoot,
    authority[0].admission.originalDocumentsRoot,
  );
  const observed = await second.session.journal.read();
  assert.equal(observed.phases.publish.payload.state, "success");
  assert.ok(observed.missing.includes("distribution"));
  assert.notEqual(observed.status, "complete");
  const writes = [...state.writes];
  const third = await publicationSuccessor(f, second.session, 500);
  const replayed = await applyPipelinePublication(
    third.context,
    f.host,
    path.join(f.root, "follow-up-recovery"),
    {},
    ports,
  );
  assert.deepEqual(replayed, complete);
  assert.deepEqual(state.writes, writes);
});
