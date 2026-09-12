import test from "node:test";
import assert from "node:assert/strict";
import { recoveryBuildFixture } from "./helpers/pipeline-recovery.mjs";
import { selectExecutionRuntimeAction } from "../packages/core/runtime/entry/actions.js";
import { runtime } from "./helpers/business-attempt.mjs";

test("an internal wake continues the admitted repaired runtime without reading a stale consumer lock or selecting a new override", async () => {
  const f = await recoveryBuildFixture();
  const outputs = {},
    calls = [];
  const values = {
    token: "fixture",
    "pipeline-attempt": f.session.observed.attempt,
    "workflow-sha": "9".repeat(40),
    "workflow-ref":
      "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4",
  };
  const core = {
    getInput: (name) => values[name] || "",
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
  const env = {
    GITHUB_REPOSITORY: f.host.repository,
    GITHUB_SHA: "8".repeat(40),
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "repository_dispatch",
    GITHUB_ACTOR: "github-actions[bot]",
  };
  const dependencies = {
    githubFactory: () => ({}),
    pipelineLookup: f.host.index,
    providerFactory: () => ({
      authorize: async (request) => {
        calls.push(request.origin);
      },
      readLock: async () =>
        assert.fail(
          "A repaired attempt must not fall back to the old consumer lock",
        ),
      resolveRef: async () =>
        assert.fail("Recovery continuation already has an exact runtime"),
      readProtocol: async ({ sha }) => {
        assert.equal(sha, f.host.runtime.sha);
        return { schema: "buildchain.runtime-entry/v1", protocol: 1 };
      },
    }),
  };
  await selectExecutionRuntimeAction(core, env, dependencies);
  assert.equal(outputs.sha, f.host.runtime.sha);
  assert.equal(outputs.origin, "attempt-recovery");
  assert.equal(outputs["source-sha"], f.f.source.commit);
  assert.equal(outputs.selection.recovery.attempt, f.session.observed.attempt);
  assert.deepEqual(calls, ["attempt-recovery"]);
  values["runtime-ref"] = "v4-alpha";
  await assert.rejects(
    selectExecutionRuntimeAction(core, env, dependencies),
    /new recovery attempt/,
  );
});

test("a normal event using the old runtime redirects to the recovered attempt without writing its phases", async () => {
  const f = await recoveryBuildFixture();
  const before = structuredClone(f.snapshot().records);
  f.host.runtime = runtime;
  const result = await f.wake();
  assert.equal(
    result.reason,
    "admitted-recovery-runtime-continuation-required",
  );
  assert.equal(result.attempt, f.session.observed.attempt);
  assert.deepEqual(f.snapshot().records, before);
});
