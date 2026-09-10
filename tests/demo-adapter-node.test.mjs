import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  demoContainerArguments,
  runDemoContainer,
} from "../packages/core/build/demo/container.js";
import { qualifyDemoAdapter, renderQualifiedDemo } from "../packages/core/build/demo/adapter-transactions.js";
import { resolveArtifactCoordinate } from "../packages/core/build/artifact-coordinate.js";
const env = {
  workspace: "/tmp/demo fixture",
  runtimeRoot: "/tmp/demo fixture/.buildchain/runtime",
  rendererImage: `ghcr.io/demo/renderer@sha256:${"a".repeat(64)}`,
  sourceSha: "b".repeat(40),
  mediaProfile: "archive-v1",
  gateRoot: `sha256:${"c".repeat(64)}`,
  adapterPath: "scripts/demo $(touch injected)",
  githubOutput: "/tmp/output",
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
    assert.ok(args.includes(env.rendererImage));
    assert.throws(
      () =>
        demoContainerArguments(
          { ...env, rendererImage: "renderer:latest" },
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
test("adapter qualification completes its bounded transaction before sealing exact coordinates", () => {
 const calls = []; let received;
 const result = qualifyDemoAdapter(env, {
  runAdapter: request => { calls.push("adapter"); assert.equal(request.adapter, env.adapterPath); },
  prepareSmoke: () => calls.push("prepare"), runContainer: (_request, operation) => calls.push(operation),
  finalizeGate: request => { received = request; calls.push("seal"); return { root: env.gateRoot }; },
 });
 assert.deepEqual(calls, ["adapter", "prepare", "smoke", "seal"]);
 assert.equal(received.sourceSha, env.sourceSha); assert.equal(result.root, env.gateRoot);
});
test("Gate rejection prevents rendering and inspection effects", t => {
 const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "demo-render-reject-"));
 t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
 let rendered = false;
 assert.throws(() => renderQualifiedDemo({ ...env, workspace }, { verifyGate: () => { throw new Error("Gate root drift"); }, runContainer: () => { rendered = true; } }), /Gate root drift/u);
 assert.equal(rendered, false);
});
test("container provider failure retains original exit status", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "demo-provider-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  assert.throws(
    () =>
      runDemoContainer(
        { ...env, workspace: cwd },
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
        resolveArtifactCoordinate({name: "source", digest: `sha256:${"d".repeat(64)}`, sourceSha: "a".repeat(40), runAttempt: "1"}, {
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
      fs.readFileSync(`actions/build/demo/adapter-${phase}/action.yml`, "utf8"),
    );
    assert.equal(
      workflow.jobs[phase].steps.at(-1).uses,
      `./.buildchain/workflow-shell/actions/build/demo/adapter-${phase}`,
    );
    assert.match(action.runs.steps.at(-1).if, /always/);
  }
});
