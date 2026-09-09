import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  demoContainerArguments,
  demoFinalizationArguments,
  runDemoContainer,
} from "../packages/core/build/nodes/demo-adapter.mjs";
import { resolveSourceArtifact } from "../packages/core/build/nodes/demo-artifact-coordinate.mjs";
const env = {
  GITHUB_WORKSPACE: "/tmp/demo fixture",
  RENDERER_IMAGE: `ghcr.io/demo/renderer@sha256:${"a".repeat(64)}`,
  SOURCE_SHA: "b".repeat(40),
  MEDIA_PROFILE: "archive-v1",
  GATE_ROOT: `sha256:${"c".repeat(64)}`,
  ADAPTER_PATH: "scripts/demo $(touch injected)",
  GITHUB_OUTPUT: "/tmp/output",
};
test("all demo containers retain immutable image, isolated filesystem and disabled network", () => {
  for (const operation of [
    "smoke",
    "render",
    "inspect-smoke",
    "inspect-render",
  ]) {
    const args = demoContainerArguments(env, operation, () => false);
    assert.equal(args[args.indexOf("--network") + 1], "none");
    assert.ok(args.includes("--read-only"));
    assert.match(args[args.indexOf("--tmpfs") + 1], /noexec,nosuid/);
    assert.ok(args.includes(env.RENDERER_IMAGE));
    assert.throws(
      () =>
        demoContainerArguments(
          { ...env, RENDERER_IMAGE: "renderer:latest" },
          operation,
        ),
      /immutable/,
    );
  }
  const render = demoContainerArguments(env, "render", (name) =>
    name.endsWith("rendition-set.json"),
  );
  assert.ok(render.includes("--terminal-capture"));
  assert.ok(render.includes("--rendition-set"));
  assert.equal(
    demoContainerArguments(env, "smoke", () => true).includes(
      "--terminal-capture",
    ),
    false,
  );
});
test("demo finalization preserves evidence coordinates and literal adapter arguments", () => {
  const gate = demoFinalizationArguments(env, "finalize-gate", () => true);
  assert.equal(gate[gate.indexOf("--adapter") + 1], env.ADAPTER_PATH);
  assert.equal(gate[gate.indexOf("--source-sha") + 1], env.SOURCE_SHA);
  assert.ok(gate.includes("--media-inspection"));
  const media = demoFinalizationArguments(env, "finalize-media", () => false);
  assert.equal(media[media.indexOf("--gate-root") + 1], env.GATE_ROOT);
  assert.equal(media.includes("--media-inspection"), false);
});
test("container provider failure retains original exit status", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "demo-provider-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  assert.throws(
    () =>
      runDemoContainer(
        { ...env, GITHUB_WORKSPACE: cwd },
        "smoke",
        (program, args) => {
          calls.push({ program, args });
          if (args[0] === "run")
            throw Object.assign(new Error("provider failed"), { status: 37 });
        },
      ),
    (error) => error.status === 37,
  );
  assert.deepEqual(
    calls.map((x) => x.args[0]),
    ["pull", "run"],
  );
});
test("artifact resolution rejects ambiguous, missing and digest-mismatched coordinates before outputs", async () => {
  const old = {
    EXPECTED_NAME: process.env.EXPECTED_NAME,
    EXPECTED_DIGEST: process.env.EXPECTED_DIGEST,
  };
  process.env.EXPECTED_NAME = "source";
  process.env.EXPECTED_DIGEST = `sha256:${"d".repeat(64)}`;
  try {
    for (const artifacts of [
      [],
      [{ name: "source", digest: "wrong" }],
      [{ name: "source" }, { name: "source" }],
    ]) {
      await assert.rejects(
        resolveSourceArtifact({
          github: {
            paginate: async () => artifacts,
            rest: { actions: { listWorkflowRunArtifacts() {} } },
          },
          context: { repo: { owner: "owner", repo: "repo" }, runId: 1 },
          core: {
            setOutput() {
              assert.fail("must reject before emitting coordinate");
            },
          },
        }),
        /exactly one|digest mismatch/,
      );
    }
  } finally {
    for (const [k, v] of Object.entries(old))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});
test("demo public component retains gate-before-render and diagnostic failure collection", () => {
  const workflow = YAML.parse(
    fs.readFileSync(".github/workflows/.build-demo-adapter.yml", "utf8"),
  );
  assert.equal(workflow.jobs.render.needs, "gate");
  for (const phase of ["gate", "render"]) {
    const action = YAML.parse(
      fs.readFileSync(`actions/build/demo-adapter-${phase}/action.yml`, "utf8"),
    );
    assert.equal(
      workflow.jobs[phase].steps.at(-1).uses,
      `./.buildchain/workflow-shell/actions/build/demo-adapter-${phase}`,
    );
    assert.match(action.runs.steps.at(-1).if, /always/);
  }
});
