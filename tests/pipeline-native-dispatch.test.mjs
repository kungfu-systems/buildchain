import test from "node:test";
import assert from "node:assert/strict";
import { executePipelineNativeDispatch } from "../packages/core/publication/pipeline/native-dispatch.js";
import { githubPipelineNativeDispatch } from "../packages/core/providers/github/pipeline-native-dispatch.js";

function fixture() {
  const operation = {
    authority: {
      repository: "kungfu-systems/buildchain",
      ref: "v4-alpha",
      entrySha: "a".repeat(40),
    },
    source: { repository: "example/product", runId: 10, runAttempt: 1 },
    correlationId: "exact-correlation",
    runtimeSha: "b".repeat(40),
    requestRoot: `sha256:${"c".repeat(64)}`,
    requestArtifact: "unsigned",
    resultArtifact: "signed",
  };
  const state = {
    operation,
    writes: 0,
    values: [],
    calls: [],
    visible: false,
    complete: false,
    lost: false,
  };
  const run = {
    repository: { full_name: "kungfu-systems/buildchain" },
    id: 20,
    run_attempt: 1,
    path: ".github/workflows/public-release-signing-authority.yml",
    event: "workflow_dispatch",
    head_sha: operation.authority.entrySha,
    display_title: "Sign example/product run 10 (exact-correlation)",
  };
  const request = async (url, options = {}) => {
    state.calls.push(url);
    if (url.endsWith("/commits/v4-alpha"))
      return { sha: operation.authority.entrySha };
    if (options.method === "POST") {
      assert.equal(state.values[0].state, "pending");
      assert.equal(options.body.inputs["runtime-ref"], operation.runtimeSha);
      state.writes++;
      state.visible = true;
      if (state.lost) throw new Error("lost response");
      return undefined;
    }
    const observed = {
      ...run,
      status: state.complete ? "completed" : "in_progress",
      conclusion: state.complete ? "success" : null,
    };
    if (url.endsWith("/actions/runs/20")) return observed;
    if (url.includes("/runs?event=workflow_dispatch"))
      return { workflow_runs: state.visible ? [observed] : [] };
    throw new Error(`Unexpected provider path ${url}`);
  };
  state.input = {
    operation,
    provider: githubPipelineNativeDispatch(request),
    maximumReads: 2,
    wait: async () => {
      state.complete = true;
    },
    journal: {
      fence: async () => {},
      materials: async () => state.values,
      record: async (_id, value) => {
        if (
          !state.values.some((v) => JSON.stringify(v) === JSON.stringify(value))
        )
          state.values.push(value);
      },
    },
  };
  return state;
}

for (const lost of [false, true])
  test(`native dispatch retains intent before one POST and resumes the same execution (${lost})`, async () => {
    const f = fixture();
    f.lost = lost;
    const completed = await executePipelineNativeDispatch(f.input);
    assert.equal(completed.runId, 20);
    assert.equal(f.writes, 1);
    assert.ok(f.values.some((value) => value.state === "observed"));
    const resumed = await executePipelineNativeDispatch(f.input);
    assert.deepEqual(resumed, completed);
    assert.equal(f.writes, 1);
    assert.ok(f.calls.at(-1).endsWith("/actions/runs/20"));
  });

test("unresolved native dispatch is retained and recovery never repeats its POST", async () => {
  const f = fixture();
  f.input.maximumReads = 1;
  await assert.rejects(
    executePipelineNativeDispatch(f.input),
    /outcome is unresolved/,
  );
  await assert.rejects(
    executePipelineNativeDispatch(f.input),
    /outcome is unresolved/,
  );
  assert.equal(f.writes, 1);
  f.complete = true;
  await executePipelineNativeDispatch(f.input);
  assert.equal(f.writes, 1);
});

test("native dispatch never crosses a lost journal fence", async () => {
  const f = fixture();
  let fences = 0;
  f.input.journal.fence = async () => {
    if (++fences === 3) throw new Error("lost fence");
  };
  await assert.rejects(executePipelineNativeDispatch(f.input), /lost fence/);
  assert.equal(f.writes, 0);
});
