import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { identities, runtime } from "./helpers/business-attempt.mjs";
import {
  pipelineIntent,
  sourceGeneration,
  businessAttempt,
  PIPELINE_PHASES,
} from "../packages/core/workflow/attempt/identity.js";
import {
  readBusinessAttempt,
  MAX_ATTEMPT_RECORDS,
} from "../packages/core/workflow/attempt/reader.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
const read = (f, records) => readBusinessAttempt({ intent: f.intent, records });

test("PR intent, source/config/base generations, business retries and provider runs have independent identities", () => {
  const f = identities();
  for (const key of ["commit", "tree", "configBlob", "configDigest"]) {
    const value =
      key === "configDigest" ? `sha256:${"f".repeat(64)}` : "f".repeat(40);
    assert.notEqual(
      sourceGeneration(
        f.intent,
        { ...f.source, [key]: value },
        f.generation.baseCommit,
      ).id,
      f.generation.id,
    );
  }
  assert.notEqual(
    sourceGeneration(f.intent, f.source, "f".repeat(40)).id,
    f.generation.id,
  );
  const retry = businessAttempt({
    ...f,
    predecessor: f.attempt.id,
    requestKey: "retry",
  });
  assert.notEqual(retry.id, f.attempt.id);
  const root = f.event();
  const accepted = f.event(root, { state: "success" });
  const build = f.event(accepted, {
    phase: "build",
    state: "waiting",
    reason: "awaiting-runner",
    writer: { ...f.writer, runId: "200", jobId: "21" },
  });
  const observed = read(f, [build, root, accepted, root]);
  assert.equal(observed.status, "waiting");
  assert.equal(observed.reason, "awaiting-runner");
  assert.equal(observed.runs.length, 2);
  assert.equal(observed.attempt, f.attempt.id);
  assert.deepEqual(observed.recovery, { attempt: f.attempt.id });
});

test("the entire admitted pipeline is replayed before completion", () => {
  const f = identities(PIPELINE_PHASES),
    records = [f.event()];
  for (const phase of PIPELINE_PHASES) {
    assert.notEqual(read(f, records).status, "complete");
    records.push(f.event(records.at(-1), { phase, state: "success" }));
  }
  assert.equal(read(f, records).status, "complete");
  assert.equal(read(f, records).recovery, null);
  assert.throws(
    () => read(f, [...records, f.event(records.at(-1), { phase: "build" })]),
    /Terminal phase/,
  );
  assert.throws(
    () =>
      read(f, [
        records[0],
        f.event(records[0], { phase: "publish", state: "success" }),
      ]),
    /predecessor/,
  );
});

test("recovery retains immutable published history without inheriting success into new source", () => {
  const f = identities(["admission", "publish", "next-development"]);
  const records = [f.event()];
  for (const phase of f.intent.expectedNodes)
    records.push(
      f.event(records.at(-1), {
        phase,
        state: phase === "next-development" ? "failure" : "success",
        reason: phase === "next-development" ? "provider-unavailable" : "",
      }),
    );
  assert.equal(read(f, records).status, "failure");
  const oldBytes = JSON.stringify(records);
  const generation = sourceGeneration(
    f.intent,
    { ...f.source, commit: "f".repeat(40) },
    f.generation.baseCommit,
  );
  const attempt = businessAttempt({
    intent: f.intent,
    generation,
    predecessor: f.attempt.id,
    requestKey: "repair",
  });
  const root = f.event(null, {
    attempt,
    generation,
    runtime: { ...runtime, sha: "f".repeat(40) },
  });
  const observed = read(f, [...records, root]);
  assert.equal(observed.status, "running");
  assert.deepEqual(observed.missing, f.intent.expectedNodes);
  assert.equal(observed.history[0].phases.publish.payload.state, "success");
  assert.equal(JSON.stringify(records), oldBytes);
  assert.throws(() => read(f, [root]), /predecessor is missing/);
});

test("missing, forked, corrupt, oversized and mismatched records fail closed", () => {
  const f = identities(),
    root = f.event(),
    accepted = f.event(root, { state: "success" });
  const build = f.event(accepted, { phase: "build" });
  assert.equal(read(f, []).status, "pending");
  assert.throws(() => read(f, [accepted]), /initial root/);
  assert.throws(() => read(f, [root, build]), /gap, fork/);
  assert.throws(
    () => read(f, [root, accepted, f.event(root, { state: "waiting" })]),
    /Conflicting|fork/,
  );
  assert.throws(
    () => read(f, [root, f.event(root, { eventKey: root.payload.eventKey })]),
    /duplicate event key/,
  );
  assert.throws(
    () => read(f, [{ ...root, sequence: 12 }]),
    /identity mismatch/,
  );
  const { id, ...content } = structuredClone(root);
  content.payload.identity.schema = "invented";
  assert.throws(
    () => read(f, [{ ...content, id: recordDigest(content) }]),
    /identity mismatch/,
  );
  assert.throws(
    () => read(f, Array(MAX_ATTEMPT_RECORDS + 1).fill(root)),
    /count exceeds/,
  );
  assert.throws(() => f.event(null, { eventKey: "x".repeat(241) }), /bound/);
  assert.throws(
    () =>
      pipelineIntent({
        ...f.intent.source,
        repository: f.intent.repository,
        runtime,
        phases: ["admission", "publish", "build"],
      }),
    /pipeline order/,
  );
});

test("retained standalone reader replays in a clean permission-restricted process", () => {
  const f = identities(),
    root = f.event();
  const result = spawnSync(
    process.execPath,
    [
      "--permission",
      "--allow-fs-read=dist/readers/business-attempt.cjs",
      "dist/readers/business-attempt.cjs",
    ],
    {
      input: JSON.stringify({ intent: f.intent, records: [root] }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).attempt, f.attempt.id);
  assert.equal(JSON.parse(result.stdout).status, "running");
});

test("cancellation and supersession retain reasons and cannot be overwritten", () => {
  const f = identities(),
    root = f.event();
  for (const state of ["cancelled", "superseded"]) {
    const stop = f.event(root, {
      state,
      reason: "PR source no longer current",
    });
    const result = read(f, [root, stop]);
    assert.equal(result.status, state);
    assert.equal(result.reason, "PR source no longer current");
    assert.deepEqual(result.recovery, { attempt: f.attempt.id });
    assert.throws(
      () => read(f, [root, stop, f.event(stop, { state: "success" })]),
      /Terminal phase/,
    );
  }
});
