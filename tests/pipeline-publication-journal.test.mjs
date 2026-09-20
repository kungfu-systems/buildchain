import { publicationFixture } from "./helpers/pipeline-publication-session.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { preparePipelinePublication } from "../packages/core/publication/pipeline/prepare.js";
import { publicationContext } from "../packages/core/publication/pipeline/context.js";
import { pipelinePublicationJournal } from "../packages/core/publication/pipeline/journal.js";
import {
  readRecoveryPublicationMaterials,
  recoveryPublicationMaterial,
} from "../packages/core/publication/pipeline/recovery-materials.js";
import { importRecoveredPublication } from "../packages/core/publication/pipeline/recovery-import.js";
import { publicationImportedValues } from "../packages/core/publication/pipeline/imported-materials.js";
import { prepareRecoveredPublication } from "../packages/core/publication/pipeline/recovery-prepare.js";
import {
  selectRecoveryAttempt,
  openRecoveryAttempt,
} from "../packages/core/workflow/pipeline/recovery-session.js";
import { planPipelineRecovery } from "../packages/core/workflow/pipeline/recovery-plan.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("unsigned conflicting plans remain ambiguous and cannot select their own recovery authority", async () => {
  const { f, publisher, attempt } = await publicationFixture();
  const { context } = await preparePipelinePublication(
    attempt,
    publisher,
    f.host,
  );
  const { session, journal } = await publicationContext(context, f.host);
  const { root, ...body } = context.plan;
  body.publisher = { ...body.publisher, workflowSha: "8".repeat(40) };
  await journal.record("publication/plan", {
    ...body,
    root: recordDigest(body),
  });
  session.observed = await session.journal.read();
  const materials = await readRecoveryPublicationMaterials(session, f.host);
  assert.throws(
    () => recoveryPublicationMaterial(materials, "publication/plan/"),
    /one exact retained material/,
  );
});

test("publication freezes the real protected source and defining publisher, and fences duplicate/late workers across jobs", async () => {
  const { f, publisher, merge, complete, attempt } = await publicationFixture();
  const first = await preparePipelinePublication(attempt, publisher, f.host);
  assert.equal(first.operation, "build");
  assert.equal(first.context.plan.source.commit, merge.commit);
  assert.notEqual(first.context.plan.source.commit, f.f.source.commit);
  assert.equal(first.context.plan.publisher.workflowSha, publisher);
  assert.notEqual(
    first.context.plan.publisher.workflowSha,
    first.context.plan.runtime.commit,
  );
  await publicationContext(first.context, f.host);
  const secondHost = {
    ...f.host,
    runId: 201,
    writer: { ...f.host.writer, runId: "201", jobId: "22" },
  };
  assert.equal(
    (await preparePipelinePublication(attempt, publisher, secondHost))
      .operation,
    "wait",
  );
  complete.add(200);
  const resumed = await preparePipelinePublication(
    attempt,
    publisher,
    secondHost,
  );
  assert.deepEqual(resumed.context.plan, first.context.plan);
  await assert.rejects(
    publicationContext(first.context, f.host),
    /lost its exact provider/,
  );
  await assert.rejects(
    publicationContext(
      {
        ...resumed.context,
        plan: { ...resumed.context.plan, version: "9.0.0" },
      },
      secondHost,
    ),
    /not retained/,
  );
  await assert.rejects(
    preparePipelinePublication(attempt, "9".repeat(40), secondHost),
    /exact hosted/,
  );
});

test("recovery adopts original materials and the derived publisher/source in one immutable journal append", async () => {
  const { f, publisher, attempt } = await publicationFixture();
  const first = await preparePipelinePublication(attempt, publisher, f.host);
  const old = (await publicationContext(first.context, f.host)).session;
  await old.progress.progress({
    attempt,
    phase: "publish",
    state: "failure",
    eventKey: "signing-interrupted",
  });
  old.observed = await old.journal.read();
  const materials = await readRecoveryPublicationMaterials(old, f.host);
  const publication = { mode: "build", materials };
  f.host.runId = 300;
  f.host.writer = { ...f.host.writer, runId: "300", jobId: "99" };
  const entry = {
    repository: "kungfu-systems/buildchain",
    workflow: ".github/workflows/public-ops-recover.yml",
    sha: "9".repeat(40),
  };
  const selected = await selectRecoveryAttempt(attempt, f.host, entry);
  const evidence = { publication };
  const plan = planPipelineRecovery({
    observed: selected.observed,
    runtime: f.host.runtime,
    entry,
    evidenceRoot: recordDigest(evidence),
    nodes: selected.intent.expectedNodes.map((phase) => ({
      phase,
      operation: "reconcile",
      reason: "Reobserve each original result",
      evidenceRoots: [],
    })),
  });
  const session = await openRecoveryAttempt(selected, plan, f.host, evidence);
  for (const phase of ["admission", "build", "review", "merge"])
    await session.progress.progress({
      attempt: session.observed.attempt,
      phase,
      state: "success",
      eventKey: `recovered:${phase}`,
    });
  const journal = pipelinePublicationJournal(session, f.host);
  const execution = {
    attempt: session.observed.attempt,
    runtime: first.context.plan.runtime,
    publisher: { ...first.context.plan.publisher, workflowSha: entry.sha },
  };
  const before = f.snapshot().records.length;
  await importRecoveredPublication(
    publication,
    execution,
    plan.root,
    journal,
    "publish",
  );
  assert.equal(f.snapshot().records.length, before + 1);
  const imported = await journal.materials("publication/plan/");
  const source = await journal.materials("publication/materialization/");
  assert.equal(imported.length, 1);
  assert.equal(source.length, 1);
  assert.notEqual(imported[0].root, first.context.plan.root);
  assert.equal(source[0].planRoot, imported[0].root);
  assert.deepEqual(source[0].source, first.context.materialization.source);
  assert.deepEqual(await journal.materials("publication/predecessor-plan/"), [
    first.context.plan,
  ]);
  await importRecoveredPublication(
    publication,
    execution,
    plan.root,
    journal,
    "publish",
  );
  assert.equal(f.snapshot().records.length, before + 1);
  session.observed = await session.journal.read();
  const recovered = await readRecoveryPublicationMaterials(session, f.host);
  assert(
    recovered.some(
      (item) =>
        item.id.startsWith("publication/plan/") && item.memberId === item.id,
    ),
  );
  const container = await f.host
    .materialStore(session)
    .read(recovered[0].reference);
  assert.equal(publicationImportedValues(container).length, recovered.length);
  // A different worker resumes the same import after publish/distribution.
  // Its new phase must not rewrite or reappend the original import event.
  for (const phase of ["publish", "distribution"])
    await session.progress.progress({
      attempt: session.observed.attempt,
      phase,
      state: "success",
      eventKey: `finished:${phase}`,
    });
  const beforeTail = structuredClone(f.snapshot().records);
  const resumedJournal = pipelinePublicationJournal(session, f.host);
  await importRecoveredPublication(
    publication,
    execution,
    plan.root,
    resumedJournal,
    "next-development",
  );
  assert.deepEqual(f.snapshot().records, beforeTail);
  // Other journal results remain phase-bound; the import replay is explicit.
  await assert.rejects(
    resumedJournal.record("publication/recovery-import", container, {
      phase: "next-development",
    }),
    /immutable recorded result/,
  );
  // Isolate preparation's retained-plan decision. Signature verification is
  // exercised by the signed publication recovery/apply tests.
  await resumedJournal.record(
    "publication/qualified",
    {
      qualified: { planRoot: imported[0].root },
    },
    { phase: "next-development" },
  );
  const beforeEntryMove = structuredClone(f.snapshot().records);
  const prepared = await prepareRecoveredPublication(
    session,
    "8".repeat(40),
    f.host,
    resumedJournal,
    "next-development",
  );
  assert.equal(prepared.mode, "qualified");
  assert.equal(prepared.preserveTransaction, true);
  assert.equal(prepared.execution.publisher.workflowSha, "8".repeat(40));
  assert.deepEqual(
    await resumedJournal.materials("publication/plan/"),
    imported,
  );
  assert.deepEqual(f.snapshot().records, beforeEntryMove);
  const tampered = structuredClone(container);
  tampered.values[0].value = { changed: true };
  assert.throws(
    () => publicationImportedValues(tampered),
    /immutable material bundle/,
  );
});
