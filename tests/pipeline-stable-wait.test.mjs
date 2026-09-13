import assert from "node:assert/strict";
import test from "node:test";
import { publicationFixture } from "./helpers/pipeline-publication-session.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { evaluateStableReleaseGate } from "../packages/core/release/stable-release-gate.js";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import { preparePipelinePublication } from "../packages/core/publication/pipeline/prepare.js";
import { publicationContext } from "../packages/core/publication/pipeline/context.js";
import { claimPipelinePublicationWorker } from "../packages/core/publication/pipeline/worker.js";
import {
  planPipelineStableWait,
  retainedPipelineStableWait,
  wakePipelineStableWait,
} from "../packages/core/publication/pipeline/stable-wait.js";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";
import {
  selectRecoveryAttempt,
  openRecoveryAttempt,
} from "../packages/core/workflow/pipeline/recovery-session.js";
import { planPipelineRecovery } from "../packages/core/workflow/pipeline/recovery-plan.js";

const start = "2026-09-13T00:20:00.000Z";
function rooted(value) {
  const { root, ...body } = value;
  return { ...body, root: recordDigest(body) };
}

// The real gate evaluates deterministic provider facts; these are test data,
// not qualification for a published version.
function eligibility(plan, overrides = {}) {
  const facts = {
    policy: {
      enabled: true,
      minimumStableIntervalSeconds: plan.stablePolicy.minimum_interval_seconds,
      minimumCanarySoakSeconds: plan.stablePolicy.minimum_soak_seconds,
      productPathPrefixes: ["packages/"],
      requiredCanaries: [
        {
          id: "entry",
          source: "public-build",
          context: "",
          allowedAttestors: [],
        },
      ],
    },
    channel: "release",
    now: start,
    candidate: {
      tag: "v1.0.0-alpha.1",
      sha: plan.intentSource.commit,
      publishedAt: "2026-09-13T00:00:00Z",
    },
    previousStable: {
      tag: "v0.9.0",
      sha: "b".repeat(40),
      publishedAt: "2026-09-12T00:00:00Z",
    },
    changedPaths: ["packages/product.js"],
    impact: {
      release: { version: "1.0.0-alpha.1" },
      summary: "Product change",
      surfaceImpacts: [{ id: "product" }],
    },
    canaries: [
      {
        id: "entry",
        status: "success",
        candidateSha: plan.intentSource.commit,
        completedAt: start,
      },
    ],
    ...overrides,
  };
  const report = evaluateStableReleaseGate(facts);
  return rooted({
    schema: "buildchain.pipeline-stable-eligibility/v1",
    planRoot: plan.root,
    evaluatedAt: facts.now,
    report,
  });
}

async function fixture() {
  const f = await publicationFixture();
  const first = await preparePipelinePublication(
    f.attempt,
    f.publisher,
    f.f.host,
  );
  const { journal, session } = await publicationContext(
    first.context,
    f.f.host,
  );
  const contract = structuredClone(f.f.admission.plan);
  contract.stable = {
    minimum_interval_seconds: 86400,
    minimum_soak_seconds: 3600,
    product_paths: ["packages/"],
    impact_file: "release-impact.json",
    require_published_entry: true,
  };
  const plan = planPipelinePublication({
    ...first.context.plan,
    contract,
    route: contract.channels[2],
  });
  const coordinates = {
    attempt: f.attempt,
    generation: first.context.generation,
    phase: "publish",
  };
  const wait = planPipelineStableWait(plan, eligibility(plan), coordinates);
  const retain = (value = wait) =>
    journal.record("publication/stable-wait", value, {
      phase: "publish",
      state: "waiting",
    });
  return { ...f, first, journal, session, plan, coordinates, wait, retain };
}

test("only time gates defer publication, using the later source-bound deadline", async () => {
  const f = await fixture();
  assert.equal(f.wait.notBefore, "2026-09-13T01:20:00.000Z");
  const both = eligibility(f.plan, {
    previousStable: {
      tag: "v0.9.0",
      sha: "b".repeat(40),
      publishedAt: "2026-09-12T12:00:00Z",
    },
  });
  assert.deepEqual(both.report.summary.failedChecks.toSorted(), [
    "stable.canary_soak",
    "stable.minimum_interval",
  ]);
  assert.equal(
    planPipelineStableWait(f.plan, both, f.coordinates).notBefore,
    "2026-09-13T12:00:00.000Z",
  );
  for (const changed of [
    { canaries: [] },
    { changedPaths: [] },
    { impact: {} },
  ]) {
    assert.equal(
      planPipelineStableWait(
        f.plan,
        eligibility(f.plan, changed),
        f.coordinates,
      ),
      null,
    );
  }
  assert.equal(
    planPipelineStableWait(
      f.plan,
      eligibility(f.plan, { now: "2026-09-13T02:00:00Z" }),
      f.coordinates,
    ),
    null,
  );
});

test("wait cannot substitute its plan, policy duration, generation or evaluation clock", async () => {
  const f = await fixture(),
    proof = eligibility(f.plan);
  assert.throws(
    () =>
      planPipelineStableWait(
        f.plan,
        { ...proof, planRoot: "other" },
        f.coordinates,
      ),
    /retained.*bytes/,
  );
  assert.throws(
    () =>
      planPipelineStableWait(f.plan, proof, {
        ...f.coordinates,
        generation: "other",
      }),
    /coordinates/,
  );
  const wrongDuration = structuredClone(proof);
  wrongDuration.report.checks.find(
    (c) => c.id === "stable.canary_soak",
  ).details.requiredSeconds = 0;
  assert.throws(
    () => planPipelineStableWait(f.plan, rooted(wrongDuration), f.coordinates),
    /source-bound policy/,
  );
  assert.throws(
    () =>
      planPipelineStableWait(
        f.plan,
        rooted({ ...proof, evaluatedAt: "invalid" }),
        f.coordinates,
      ),
    /timestamp/,
  );
  assert.throws(
    () =>
      planPipelineStableWait(
        f.plan,
        rooted({ ...proof, evaluatedAt: "2026-09-14T00:00:00Z" }),
        f.coordinates,
      ),
    /timestamp/,
  );
});

test("a retained wait uses bounded polling and wakes the exact attempt once after fifteen minutes", async () => {
  const f = await fixture();
  await f.retain();
  let clock = Date.parse(start);
  const durations = [];
  const result = await wakePipelineStableWait(f.wait, f.f.host, {
    now: () => clock,
    sleep: async (ms) => {
      durations.push(ms);
      clock += ms;
    },
  });
  assert.equal(result.status, "woken");
  assert.equal(clock - Date.parse(start), 15 * 60 * 1000);
  assert.equal(durations.length, 30);
  assert(durations.every((ms) => ms > 0 && ms <= 30000));
  assert.deepEqual(
    f.f.effects.filter((x) => x.wake),
    [{ wake: f.attempt }],
  );
  assert.equal(f.f.observed().phases.publish.payload.state, "waiting");
});

test("a short remaining soak wakes at its retained deadline and never sleeps beyond it", async () => {
  const f = await fixture();
  await f.retain();
  let clock = Date.parse(f.wait.notBefore) - 1000;
  const durations = [];
  await wakePipelineStableWait(f.wait, f.f.host, {
    now: () => clock,
    sleep: async (ms) => {
      durations.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(durations, [1000]);
  assert.equal(clock, Date.parse(f.wait.notBefore));
});

test("an unretained or superseded timer cannot wake, even with a valid content root", async () => {
  const f = await fixture();
  const options = { now: () => Date.parse(f.wait.notBefore) };
  assert.equal(
    (await wakePipelineStableWait(f.wait, f.f.host, options)).status,
    "obsolete",
  );
  await f.retain();
  const forged = rooted({ ...f.wait, notBefore: start });
  assert.equal(
    (await wakePipelineStableWait(forged, f.f.host, options)).status,
    "obsolete",
  );
  await f.journal.record("publication/new-work", { revision: 1 });
  assert.equal(
    (await wakePipelineStableWait(f.wait, f.f.host, options)).status,
    "obsolete",
  );
  assert.deepEqual(
    f.f.effects.filter((x) => x.wake),
    [],
  );
});

test("the waiter stops during polling when publication advances", async () => {
  const f = await fixture();
  await f.retain();
  let clock = Date.parse(start),
    sleeps = 0;
  const result = await wakePipelineStableWait(f.wait, f.f.host, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps++;
      await f.journal.record(
        "publication/complete",
        { outcome: "complete" },
        { state: "success" },
      );
    },
  });
  assert.equal(result.status, "obsolete");
  assert.equal(sleeps, 1);
  assert.deepEqual(
    f.f.effects.filter((x) => x.wake),
    [],
  );
});

test("retained timers must still bind the current native source and repository", async () => {
  const f = await fixture();
  await f.retain(rooted({ ...f.wait, sourceRoot: recordDigest("foreign") }));
  await assert.rejects(
    retainedPipelineStableWait(f.f.observed(), f.f.host),
    /native publication coordinates/,
  );
  await assert.rejects(
    retainedPipelineStableWait(f.f.observed(), {
      ...f.f.host,
      repository: "foreign/repo",
    }),
    /repository boundary/,
  );
});

test("a time-only waiting worker can be replaced before its outer run ends, fencing the old writer", async () => {
  const f = await fixture();
  const successor = {
    ...f.f.host,
    runId: 201,
    writer: { ...f.f.host.writer, runId: "201", jobId: "22" },
  };
  assert.equal(
    await claimPipelinePublicationWorker(f.attempt, f.publisher, successor),
    null,
  );
  await f.retain();
  assert(
    await claimPipelinePublicationWorker(f.attempt, f.publisher, successor),
  );
  await assert.rejects(f.journal.fence(), /lost its exact provider/);
  assert.equal(
    (
      await wakePipelineStableWait(f.wait, f.f.host, {
        now: () => Date.parse(f.wait.notBefore),
      })
    ).status,
    "obsolete",
  );
  assert.equal(
    await claimPipelinePublicationWorker(f.attempt, f.publisher, {
      ...successor,
      runId: 202,
      writer: { ...successor.writer, runId: "202" },
    }),
    null,
  );
});

test("opening typed recovery invalidates the original timer without waking the replacement attempt", async () => {
  const f = await fixture();
  await f.retain();
  await f.journal.record(
    "publication/interrupted",
    { reason: "waiter failed" },
    { state: "failure" },
  );
  f.complete.add(200);
  const entry = {
    repository: "kungfu-systems/buildchain",
    workflow: ".github/workflows/public-ops-recover.yml",
    sha: "9".repeat(40),
  };
  const selected = await selectRecoveryAttempt(f.attempt, f.f.host, entry);
  const evidence = { reason: "explicit recovery during stable wait" };
  const plan = planPipelineRecovery({
    observed: selected.observed,
    runtime: f.f.host.runtime,
    entry,
    evidenceRoot: recordDigest(evidence),
    nodes: selected.intent.expectedNodes.map((phase) => ({
      phase,
      operation: "reconcile",
      reason: "Reobserve original evidence",
      evidenceRoots: [],
    })),
  });
  const recovered = await openRecoveryAttempt(
    selected,
    plan,
    f.f.host,
    evidence,
  );
  assert.notEqual(recovered.observed.attempt, f.attempt);
  const result = await wakePipelineStableWait(f.wait, f.f.host, {
    now: () => Date.parse(f.wait.notBefore),
  });
  assert.equal(result.status, "obsolete");
  assert.deepEqual(
    f.f.effects.filter((x) => x.wake),
    [],
  );
});

test("the workflow rechecks outside the publication lock and cannot settle a deferred apply", () => {
  const execute = readWorkflow(".github/workflows/.ops-pipeline-execute.yml");
  const publish = readWorkflow(
    ".github/workflows/.release-pipeline-products.yml",
  );
  const job = execute.jobs["stable-recheck"];
  assert.equal(execute.concurrency, undefined);
  assert.equal(job.needs, "publication");
  assert.notEqual(job.concurrency.group, publish.concurrency.group);
  assert.equal(job.permissions["id-token"], undefined);
  assert.equal(job["timeout-minutes"], 20);
  assert.equal(
    job.steps.at(-1).uses,
    "./.buildchain/runtime/actions/workflow/pipeline/wake",
  );
  assert.match(job.if, /needs.publication.result == 'success'/);
  assert.match(
    publish.on.workflow_call.outputs["stable-wait"].value,
    /jobs.apply.outputs.stable-wait/,
  );
  assert.match(publish.jobs.settle.if, /needs.apply.outputs.stable-wait == ''/);
});
