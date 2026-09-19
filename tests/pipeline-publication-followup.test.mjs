import assert from "node:assert/strict";
import test from "node:test";
import { publicationFixture } from "./helpers/pipeline-publication-session.mjs";
import { resumePipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { pipelinePublicationJournal } from "../packages/core/publication/pipeline/journal.js";
import { preparePipelinePublication } from "../packages/core/publication/pipeline/prepare.js";
import { createPipelinePublicationPlan } from "../packages/core/publication/pipeline/source-plan.js";
import { githubPipelineVersion } from "../packages/core/providers/github/pipeline-version.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  createReleaseReceipt,
  RELEASE_RECEIPT_CONTRACT,
} from "../packages/core/release/release-invocation.js";
import { completedPublicationRecovery } from "../packages/core/publication/pipeline/context.js";

async function fixture(phase) {
  const f = await publicationFixture({
    channel: "stable",
    stablePolicy: {
      minimum_interval_seconds: 0,
      minimum_soak_seconds: 0,
      product_paths: ["src/"],
      impact_file: "release-impact.json",
      require_published_entry: true,
    },
  });
  const host = f.f.host;
  const session = await resumePipelineSession(
    { ...host, attempt: f.attempt },
    host,
  );
  const journal = pipelinePublicationJournal(session, host);
  const plan = await createPipelinePublicationPlan(
    session,
    f.publisher,
    host,
    githubPipelineVersion(host.request, host.repository),
  );
  await journal.record("publication/plan", plan);
  // Provider material is fixture data; native phase selection, retained source
  // validation and resumed operation selection use the real journal and worker.
  const body = {
    schema: "buildchain.pipeline-version-materialization/v1",
    planRoot: plan.root,
    source: f.f.f.source,
    protectedSource: plan.source,
  };
  const materialization = { ...body, root: recordDigest(body) };
  await journal.record("publication/materialization", materialization);
  for (const completed of phase === "publish"
    ? []
    : phase === "distribution"
      ? ["publish"]
      : ["publish", "distribution"])
    await session.progress.progress({
      attempt: f.attempt,
      phase: completed,
      state: "success",
      eventKey: `completed:${completed}`,
    });
  const calls = [];
  host.request = async (url) => {
    calls.push(url);
    throw new Error("Alpha canary is unavailable after the version PR closed");
  };
  return { ...f, host, plan, materialization, calls };
}

for (const phase of ["distribution", "next-development"])
  test(`completed Stable publication resumes ${phase} without reopening Alpha qualification`, async () => {
    const f = await fixture(phase);
    const result = await preparePipelinePublication(
      f.attempt,
      f.publisher,
      f.host,
    );
    assert.equal(result.operation, "settle");
    assert.deepEqual(result.context.plan, f.plan);
    assert.deepEqual(result.context.materialization, f.materialization);
    assert.deepEqual(
      f.calls,
      [],
      "no Alpha qualification or publication provider effects",
    );
  });

test("Stable publication still requires current qualification before any publication work", async () => {
  const f = await fixture("publish");
  await assert.rejects(
    preparePipelinePublication(f.attempt, f.publisher, f.host),
    /Alpha canary is unavailable/,
  );
  assert.ok(f.calls.length > 0);
});

test("completed publication does not authorize a changed runtime or consumer plan", async () => {
  const runtime = await fixture("next-development");
  runtime.host.runtime = { ...runtime.host.runtime, sha: "8".repeat(40) };
  await assert.rejects(
    preparePipelinePublication(
      runtime.attempt,
      runtime.publisher,
      runtime.host,
    ),
    /retained publisher and runtime/,
  );
  const contract = await fixture("next-development");
  contract.f.admission.plan.products[0].build.push("node changed.mjs");
  await assert.rejects(
    preparePipelinePublication(
      contract.attempt,
      contract.publisher,
      contract.host,
    ),
    /source or contract drifted/,
  );
});

test("only an exact completed signed transaction can replace a fresh recovery publication gate", async () => {
  const context = {
    plan: { root: recordDigest("plan") },
    recovery: { preserveTransaction: true },
  };
  const retained = {
    qualified: { planRoot: context.plan.root },
    documents: {
      transaction: { transactionRoot: recordDigest("transaction") },
      passport: { passportRoot: recordDigest("passport") },
    },
  };
  const complete = {
    schema: "buildchain.pipeline-publication-complete/v1",
    completedAt: "2026-09-19T18:20:58Z",
    release: createReleaseReceipt({
      schema: RELEASE_RECEIPT_CONTRACT,
      transactionRoot: retained.documents.transaction.transactionRoot,
      releasePassportRoot: retained.documents.passport.passportRoot,
      outcome: "complete",
      providerTransactionRoot: recordDigest("effects"),
      providerStateRoot: recordDigest("state"),
      providerReceiptRoots: [recordDigest("receipt")],
    }),
  };
  let values = [];
  const journal = {
    materials: async (prefix) =>
      prefix === "publication/predecessor-complete/" ? values : [retained],
  };
  assert.equal(
    await completedPublicationRecovery(context, journal),
    null,
    "partial publication must still qualify",
  );
  values = [complete];
  assert.deepEqual(
    await completedPublicationRecovery(context, journal),
    complete,
  );
  assert.equal(
    await completedPublicationRecovery({ plan: context.plan }, journal),
    null,
    "ordinary publication cannot claim recovery authority",
  );
  for (const corrupt of [
    (v) => {
      v.release.receiptRoot = recordDigest("forged");
    },
    (v) => {
      v.release.receipt.transactionRoot = recordDigest("other");
    },
    (v) => {
      v.release.receipt.releasePassportRoot = recordDigest("other");
    },
    (v) => {
      v.release.receipt.outcome = "pending";
    },
    (v) => {
      v.completedAt = "invalid";
    },
  ]) {
    const value = structuredClone(complete);
    corrupt(value);
    values = [value];
    await assert.rejects(
      completedPublicationRecovery(context, journal),
      /retained signed transaction/,
    );
  }
  values = [complete, complete];
  await assert.rejects(
    completedPublicationRecovery(context, journal),
    /retained signed transaction/,
  );
  values = [complete];
  retained.qualified.planRoot = recordDigest("another plan");
  await assert.rejects(
    completedPublicationRecovery(context, journal),
    /retained signed transaction/,
  );
});
