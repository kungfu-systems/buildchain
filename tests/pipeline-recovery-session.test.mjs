import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { resumePipelineSession } from "../packages/core/workflow/pipeline/session.js";
import {
  planPipelineRecovery,
  recoveryRequestKey,
} from "../packages/core/workflow/pipeline/recovery-plan.js";
import {
  selectRecoveryAttempt,
  openRecoveryAttempt,
  retainedRecoveryPlan,
  retainedRecoveryEvidence,
} from "../packages/core/workflow/pipeline/recovery-session.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  pipelineRuntimeSource,
  pipelineRecoveryRuntimeSource,
} from "../packages/core/workflow/pipeline/runtime-source.js";

const entry = {
  repository: "kungfu-systems/buildchain",
  workflow: ".github/workflows/public-ops-recover.yml",
  sha: "f".repeat(40),
};

async function failedBuild() {
  const fixture = pipelineHostFixture();
  const initial = await fixture.event();
  const session = await resumePipelineSession(
    { ...fixture.host, attempt: initial.context.attempt },
    fixture.host,
  );
  await session.progress.progress({
    attempt: initial.context.attempt,
    phase: "build",
    state: "failure",
    eventKey: "failed-build",
    reason: "Product build failed",
  });
  fixture.complete();
  const selected = await selectRecoveryAttempt(
    initial.context.attempt,
    fixture.host,
    entry,
  );
  const nodes = selected.intent.expectedNodes.map((phase) => ({
    phase,
    operation: phase === "admission" ? "reuse" : "execute",
    reason:
      phase === "admission"
        ? "Exact source reobserved"
        : "Required work remains",
    evidenceRoots:
      phase === "admission" ? [recordDigest("verified-source")] : [],
  }));
  const plan = planPipelineRecovery({
    observed: selected.observed,
    runtime: fixture.host.runtime,
    entry,
    nodes,
    evidenceRoot: recordDigest({ executions: "provider-terminal-readback" }),
  });
  return {
    ...fixture,
    selected,
    plan,
    evidence: { executions: "provider-terminal-readback" },
    oldAttempt: initial.context.attempt,
  };
}

test("recovery creates an explicit deterministic successor and preserves every predecessor byte", async () => {
  const f = await failedBuild();
  const before = structuredClone(f.snapshot().records);
  const next = await openRecoveryAttempt(
    f.selected,
    f.plan,
    f.host,
    f.evidence,
  );
  assert.notEqual(next.observed.attempt, f.oldAttempt);
  assert.equal(next.observed.history.at(-1).identity.predecessor, f.oldAttempt);
  assert.deepEqual(f.snapshot().records.slice(0, before.length), before);
  assert.deepEqual(await retainedRecoveryPlan(next, f.host), f.plan);
  assert.deepEqual(
    (await retainedRecoveryEvidence(next, f.host)).evidence,
    f.evidence,
  );
  const again = await selectRecoveryAttempt(f.oldAttempt, f.host, entry);
  assert.equal(again.duplicate, true);
  assert.equal(again.observed.attempt, next.observed.attempt);
  await assert.rejects(
    pipelineRuntimeSource(
      f.oldAttempt,
      f.host.repository,
      "test",
      f.host.index,
    ),
    /Historical/,
  );
  assert.equal(
    (
      await pipelineRecoveryRuntimeSource(
        f.oldAttempt,
        f.host.repository,
        "test",
        f.host.index,
      )
    ).sha,
    f.f.source.commit,
  );
  assert.equal(f.snapshot().records.length, before.length + 1);
  await assert.rejects(
    openRecoveryAttempt(f.selected, f.plan, f.host, f.evidence),
    /terminal predecessor/,
  );
});

test("historical recovery cannot fork a current successor with another runtime or entry", async () => {
  const f = await failedBuild();
  await openRecoveryAttempt(f.selected, f.plan, f.host, f.evidence);
  const changed = {
    ...f.host,
    runtime: { ...f.host.runtime, sha: "9".repeat(40) },
  };
  await assert.rejects(
    selectRecoveryAttempt(f.oldAttempt, changed, entry),
    /Historical recovery cannot fork/,
  );
  await assert.rejects(
    selectRecoveryAttempt(f.oldAttempt, f.host, {
      ...entry,
      sha: "8".repeat(40),
    }),
    /Historical recovery cannot fork/,
  );
  assert.throws(
    () =>
      recoveryRequestKey(f.oldAttempt, f.host.runtime, {
        ...entry,
        repository: "fork/buildchain",
      }),
    /canonical runtime/,
  );
  assert.throws(
    () =>
      recoveryRequestKey(
        f.oldAttempt,
        { ...f.host.runtime, command: "untrusted" },
        entry,
      ),
    /unknown field/,
  );
});

test("recovery rejects missing node evidence, source drift and an unadmitted executor before appending", async () => {
  const f = await failedBuild();
  const count = f.snapshot().records.length;
  const nodes = structuredClone(f.plan.nodes);
  nodes[0].evidenceRoots = [];
  assert.throws(
    () =>
      planPipelineRecovery({
        observed: f.selected.observed,
        runtime: f.host.runtime,
        entry,
        nodes,
        evidenceRoot: f.plan.evidenceRoot,
      }),
    /independently qualified/,
  );
  await assert.rejects(
    openRecoveryAttempt(f.selected, f.plan, f.host, { altered: true }),
    /actual qualified evidence/,
  );
  const changed = { ...f.plan, sourceRoot: recordDigest("wrong-source") };
  const { root, ...body } = changed;
  changed.root = recordDigest(body);
  await assert.rejects(
    openRecoveryAttempt(f.selected, changed, f.host),
    /exact predecessor/,
  );
  await assert.rejects(
    openRecoveryAttempt(f.selected, f.plan, {
      ...f.host,
      runtime: { ...f.host.runtime, sha: "9".repeat(40) },
    }),
    /executor differs/,
  );
  assert.equal(f.snapshot().records.length, count);
});
