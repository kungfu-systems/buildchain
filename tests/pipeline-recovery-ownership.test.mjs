import test from "node:test";
import assert from "node:assert/strict";
import { cancellationFixture } from "./helpers/pipeline-cancellation.mjs";
import { runtime } from "./helpers/business-attempt.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { observeRecoveryOwnership } from "../packages/core/workflow/pipeline/recovery-ownership.js";
import { settleRecoveryOwnership } from "../packages/core/workflow/pipeline/recovery-ownership-settlement.js";
import { openRecoveryAttempt } from "../packages/core/workflow/pipeline/recovery-session.js";
import { planPipelineRecovery } from "../packages/core/workflow/pipeline/recovery-plan.js";

async function fixture({ active = false, merged = false, historical = false } = {}) {
  const f = await cancellationFixture({ active });
  let observed = await f.journal.read();
  const intent = observed.intent;
  const session = {
    intent,
    journal: f.journal,
    observed,
    progress: f.ports.progress,
  };
  if (active) {
    if (merged) f.qualify();
    const reference = await f
      .materialStore(session)
      .retain("delivery/execution-100-1", {
        attempt: observed.attempt,
        generation: observed.generation,
        runId: 100,
        runAttempt: 1,
      });
    await f.ports.progress.progress({
      attempt: observed.attempt,
      phase: "warrant",
      state: "waiting",
      eventKey: "native-execution",
      materials: [reference],
    });
  }
  await f.ports.progress.progress({
    attempt: observed.attempt,
    phase: "warrant",
    state: "cancelled",
    eventKey: "interrupted",
  });
  session.observed = await f.journal.read();
  const host = {
    repository: intent.repository,
    runtime: { ...runtime, sha: "f".repeat(40) },
    writer: {
      ...observed.history.at(-1).events[0].payload.writer,
      runId: "300",
    },
    materialStore: f.materialStore,
    index: { retain: async () => {} },
    delivery: () => ({
      read: async () => structuredClone(f.queue()),
      service: f.ports.service,
    }),
    runs: {
      read: async () => ({
        run: {
          id: 100,
          status: "completed",
          referenced_workflows: [
            {
              path: `kungfu-systems/buildchain/.github/workflows/${historical ? "public-ops-dev-auto-merge.yml" : ".ops-dev-auto-merge.yml"}@v4`,
            },
          ],
        },
        jobs: [
          {
            id: 1,
            name: "Credentialless native execution",
            status: "completed",
          },
          {
            id: 2,
            name: "Credentialless native evidence seal",
            status: "completed",
          },
        ],
      }),
    },
    workers: {
      observe: async (execution, owner, warrant) => {
        assert.equal(execution.attempt, owner.identity.id);
        assert.equal(execution.candidateId, warrant.candidateId);
        return { status: "completed", execution };
      },
    },
  };
  const ownership = await observeRecoveryOwnership(
    session,
    { terminal: true, predecessor: session.observed.attempt },
    host,
  );
  assert.equal(f.writes(), 0);
  const evidence = { ownership };
  const plan = planPipelineRecovery({
    observed: session.observed,
    runtime: host.runtime,
    entry: {
      repository: "kungfu-systems/buildchain",
      workflow: ".github/workflows/public-ops-recover.yml",
      sha: "f".repeat(40),
    },
    nodes: intent.expectedNodes.map((phase) => ({
      phase,
      operation: "reconcile",
      reason: "Exact interrupted native owner",
      evidenceRoots: [],
    })),
    evidenceRoot: recordDigest(evidence),
  });
  const successor = await openRecoveryAttempt(session, plan, host, evidence);
  const integration = {
    mergeCommit: "d".repeat(40),
    mergeTree: "e".repeat(40),
    build: { root: recordDigest("build") },
    root: recordDigest("integration"),
  };
  return {
    ...f,
    host,
    session: successor,
    ownership,
    qualified: merged ? { integration } : null,
  };
}

for (const active of [false, true])
  test(`recovery retains cleanup before ${active ? "active" : "queued"} native ownership changes and reads back a lost response`, async () => {
    const f = await fixture({ active });
    const original = structuredClone(f.session.observed.history[0].events);
    const method = active ? "settle" : "cancelQueued";
    const service = f.ports.service[method];
    f.ports.service[method] = async (request) => {
      const current = (await f.journal.read()).history.at(-1);
      assert.equal(current.phases.admission.payload.state, "waiting");
      const refs = current.phases.admission.payload.materials;
      const pending = await f.materialStore(f.session).read(refs[0]);
      assert.deepEqual(pending.request, request);
      return service(request);
    };
    f.lose();
    const result = await settleRecoveryOwnership(f.session, null, f.host);
    assert.equal(result.candidate.status, "cancelled");
    assert.equal(result.lostResponse, true);
    assert.equal(result.response, null);
    assert.equal(f.writes(), 1);
    const replay = await settleRecoveryOwnership(f.session, null, f.host);
    assert.equal(replay.candidate.status, "cancelled");
    assert.equal(f.writes(), 1);
    assert.deepEqual((await f.journal.read()).history[0].events, original);
  });

test("recovery reads a retained worker under its original published workflow identity", async () => {
  const f = await fixture({ active: true, historical: true });
  const original = structuredClone(f.session.observed.history[0].events);
  const result = await settleRecoveryOwnership(f.session, null, f.host);
  assert.equal(result.candidate.status, "cancelled");
  assert.equal(f.writes(), 1);
  assert.deepEqual((await f.journal.read()).history[0].events, original);
});

test("merged recovery settles the qualified original Warrant with retained proof and never cancels it", async () => {
  const f = await fixture({ active: true, merged: true });
  f.lose();
  const result = await settleRecoveryOwnership(f.session, f.qualified, f.host);
  assert.equal(result.candidate.status, "merged");
  assert.equal(result.proof.proofRoot, result.candidate.terminal.evidenceRoot);
  assert.equal(
    result.proof.warrantCandidateId,
    f.ownership.candidate.candidateId,
  );
  const replay = await settleRecoveryOwnership(f.session, f.qualified, f.host);
  assert.deepEqual(replay.proof, result.proof);
  assert.equal(f.writes(), 1);
  await assert.rejects(
    settleRecoveryOwnership(f.session, null, f.host),
    /conflicts with terminal native ownership/,
  );
  await assert.rejects(
    settleRecoveryOwnership(
      f.session,
      {
        integration: { ...f.qualified.integration, mergeTree: "9".repeat(40) },
      },
      f.host,
    ),
    /original integration proof/,
  );
});

test("unproved worker terminality and a rejected native write keep ownership fenced", async () => {
  const f = await fixture({ active: true });
  f.host.workers.observe = async () => ({ status: "in_progress" });
  await assert.rejects(
    settleRecoveryOwnership(f.session, null, f.host),
    /terminal native worker/,
  );
  assert.equal(f.writes(), 0);
  f.host.workers.observe = async () => ({ status: "completed" });
  f.ports.service.settle = async () => {
    throw new Error("native CAS rejected");
  };
  await assert.rejects(
    settleRecoveryOwnership(f.session, null, f.host),
    /native CAS rejected/,
  );
  assert.equal(f.writes(), 0);
  assert.equal(
    f.queue().activeWarrant.candidateId,
    f.ownership.candidate.candidateId,
  );
});
