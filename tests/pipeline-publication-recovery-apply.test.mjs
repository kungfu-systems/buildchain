import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { signedPublicationFixture } from "./helpers/pipeline-publication-signed.mjs";
import { publicationApplyProvider } from "./helpers/pipeline-publication-apply-provider.mjs";
import { publicationSuccessor } from "./helpers/pipeline-publication-successor.mjs";
import { applyPipelinePublication } from "../packages/core/publication/pipeline/apply.js";

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
