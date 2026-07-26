import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeGate,
  finalizeMedia,
  prepareSmoke,
  runAdapter,
  sha256,
  stableJson,
  validateAdapterOutput,
  validateSourceCoordinate,
  verifyChecksums,
  verifyGate,
  writeChecksums,
} from "../scripts/auditable-demo.mjs";

const RENDERER_IMAGE = `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-auditable-demo-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeAdapterOutput(directory, durationMs = 2500) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "complete-transcript.txt"), "build started\nartifact qualified\n");
  fs.writeFileSync(path.join(directory, "scene.json"), stableJson({
    schema: "build-images.demo-scene/v1",
    id: "qualification",
    width: 1280,
    height: 720,
    fps: 15,
    durationMs,
    title: "Qualified build",
    commandLabel: "pnpm run build",
  }));
  fs.writeFileSync(path.join(directory, "public-projection.json"), stableJson({
    schema: "build-images.demo-projection/v1",
    evidenceClass: "qualified-build-output",
    claimBoundary: "Presentation is traceable to the retained transcript and is not a screen capture.",
    cues: [{
      startMs: 0,
      endMs: durationMs,
      transcriptLines: [1, 2],
      annotation: "qualified output",
    }],
  }));
}

function writeRendererOutput(directory, inputs) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, source] of Object.entries({
    "complete-transcript.txt": inputs.transcript,
    "public-projection.json": inputs.projection,
    "scene.json": inputs.scene,
  })) {
    fs.copyFileSync(source, path.join(directory, name));
  }
  for (const name of ["demo.gif", "demo.mp4", "demo.webm", "poster.png"]) {
    fs.writeFileSync(path.join(directory, name), Buffer.from(`${name}-fixture-data`));
  }
  fs.writeFileSync(path.join(directory, "media-probe.json"), stableJson({
    schema: "build-images.demo-media-probe/v1",
    passed: true,
    errors: [],
    media: [],
  }));
  const outputs = Object.fromEntries(
    ["demo.gif", "demo.mp4", "demo.webm", "media-probe.json", "poster.png"].map((name) => [
      name,
      { root: sha256(fs.readFileSync(path.join(directory, name))) },
    ]),
  );
  fs.writeFileSync(path.join(directory, "manifest.json"), stableJson({
    schema: "build-images.auditable-demo-render/v1",
    renderer: { image: RENDERER_IMAGE },
    inputs: {
      scene: { root: sha256(fs.readFileSync(inputs.scene)) },
      transcript: { root: sha256(fs.readFileSync(inputs.transcript)) },
      projection: { root: sha256(fs.readFileSync(inputs.projection)) },
    },
    outputs,
  }));
  writeChecksums(directory);
}

test("adapter execution uses the bounded environment", { skip: process.platform === "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const source = path.join(root, "source");
  const artifact = path.join(root, "artifact");
  const output = path.join(root, "output");
  const diagnostics = path.join(root, "diagnostics");
  const coordinate = path.join(root, "source-artifact.json");
  fs.mkdirSync(source);
  fs.mkdirSync(artifact);
  fs.writeFileSync(coordinate, stableJson({
    schema: "buildchain.github-artifact-coordinate/v1",
    repository: "kungfu-systems/consumer",
    runId: "42",
    runAttempt: "1",
    sourceSha: SOURCE_SHA,
    id: "99",
    nodeId: "artifact-node",
    name: "exact-build-output",
    digest: `sha256:${"d".repeat(64)}`,
    sizeInBytes: 1024,
    createdAt: "2026-07-25T00:00:00Z",
    expiresAt: "2026-08-08T00:00:00Z",
  }));
  const adapter = path.join(source, "adapter.mjs");
  fs.writeFileSync(adapter, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const values = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => {
  if (index % 2 === 0) rows.push([value, all[index + 1]]);
  return rows;
}, []));
fs.mkdirSync(values["--output"], { recursive: true });
fs.writeFileSync(path.join(values["--output"], "complete-transcript.txt"), "artifact qualified\\n");
fs.writeFileSync(path.join(values["--output"], "scene.json"), JSON.stringify({
  schema: "build-images.demo-scene/v1", id: "qualification", width: 1280,
  height: 720, fps: 15, durationMs: 2500, title: "Qualified build"
}) + "\\n");
fs.writeFileSync(path.join(values["--output"], "public-projection.json"), JSON.stringify({
  schema: "build-images.demo-projection/v1", evidenceClass: "qualified-build-output",
  claimBoundary: "Traceable fixture output.", cues: [{
    startMs: 0, endMs: 2500, transcriptLines: [1]
  }]
}) + "\\n");
if (!process.env.HOME || process.env.TZ !== "UTC" || process.env.SOURCE_DATE_EPOCH !== "0") process.exit(9);
`);
  fs.chmodSync(adapter, 0o755);

  runAdapter({
    "--source-root": source,
    "--artifact-root": artifact,
    "--source-coordinate": coordinate,
    "--adapter": "adapter.mjs",
    "--output": output,
    "--diagnostics": diagnostics,
  });

  assert.equal(
    JSON.parse(fs.readFileSync(path.join(diagnostics, "adapter.json"), "utf8")).exitCode,
    0,
  );
  assert.equal(fs.readFileSync(path.join(output, "complete-transcript.txt"), "utf8"), "artifact qualified\n");
});

test("adapter output is strict and smoke input is bounded", (t) => {
  const root = temporaryDirectory(t);
  const adapter = path.join(root, "adapter");
  const smoke = path.join(root, "smoke");
  writeAdapterOutput(adapter, 60000);
  const validated = validateAdapterOutput(adapter);
  assert.equal(validated.scene.durationMs, 60000);

  prepareSmoke({ "--adapter-output": adapter, "--output": smoke });
  const smokeScene = JSON.parse(fs.readFileSync(path.join(smoke, "scene.json"), "utf8"));
  const smokeProjection = JSON.parse(fs.readFileSync(path.join(smoke, "public-projection.json"), "utf8"));
  assert.equal(smokeScene.durationMs, 1000);
  assert.equal(smokeScene.fps, 5);
  assert.equal(smokeProjection.cues[0].endMs, 1000);

  fs.writeFileSync(path.join(adapter, "undeclared.txt"), "no");
  assert.throws(() => validateAdapterOutput(adapter), /undeclared adapter output/);
});

test("checksums cover every member and reject tampering", (t) => {
  const root = temporaryDirectory(t);
  fs.writeFileSync(path.join(root, "one.txt"), "one");
  fs.writeFileSync(path.join(root, "two.txt"), "two");
  const digest = writeChecksums(root);
  assert.equal(verifyChecksums(root), digest);
  fs.writeFileSync(path.join(root, "two.txt"), "tampered");
  assert.throws(() => verifyChecksums(root), /checksum mismatch/);
});

test("source artifact coordinates reject ambient or mutable identities", () => {
  const valid = {
    schema: "buildchain.github-artifact-coordinate/v1",
    repository: "kungfu-systems/consumer",
    runId: "42",
    runAttempt: "1",
    sourceSha: SOURCE_SHA,
    id: "99",
    nodeId: "artifact-node",
    name: "exact-build-output",
    digest: `sha256:${"d".repeat(64)}`,
    sizeInBytes: 1024,
    createdAt: "2026-07-25T00:00:00Z",
    expiresAt: "2026-08-08T00:00:00Z",
  };
  assert.deepEqual(validateSourceCoordinate(valid), valid);
  assert.throws(
    () => validateSourceCoordinate({ ...valid, digest: "latest" }),
    /sourceArtifact.digest is invalid/,
  );
  assert.throws(
    () => validateSourceCoordinate({ ...valid, token: "ambient" }),
    /sourceArtifact.token is not declared/,
  );
});

test("qualified Gate and selective media remain bound to exact roots", (t) => {
  const root = temporaryDirectory(t);
  const adapter = path.join(root, "adapter");
  const smokeInput = path.join(root, "smoke-input");
  const smokeOutput = path.join(root, "smoke-output");
  const diagnostics = path.join(root, "diagnostics");
  const gate = path.join(root, "gate");
  const fullOutput = path.join(root, "full-output");
  const media = path.join(root, "media");
  writeAdapterOutput(adapter);
  prepareSmoke({ "--adapter-output": adapter, "--output": smokeInput });
  writeRendererOutput(smokeOutput, {
    transcript: path.join(smokeInput, "complete-transcript.txt"),
    projection: path.join(smokeInput, "public-projection.json"),
    scene: path.join(smokeInput, "scene.json"),
  });
  fs.mkdirSync(diagnostics);
  fs.writeFileSync(path.join(diagnostics, "adapter.json"), stableJson({
    schema: "buildchain.auditable-demo-adapter-execution/v1",
    path: "scripts/demo-adapter",
    sha256: `sha256:${"c".repeat(64)}`,
    exitCode: 0,
  }));
  const sourceCoordinate = path.join(root, "source-artifact.json");
  fs.writeFileSync(sourceCoordinate, stableJson({
    schema: "buildchain.github-artifact-coordinate/v1",
    repository: "kungfu-systems/consumer",
    runId: "42",
    runAttempt: "1",
    sourceSha: SOURCE_SHA,
    id: "99",
    nodeId: "artifact-node",
    name: "exact-build-output",
    digest: `sha256:${"d".repeat(64)}`,
    sizeInBytes: 1024,
    createdAt: "2026-07-25T00:00:00Z",
    expiresAt: "2026-08-08T00:00:00Z",
  }));
  finalizeGate({
    "--adapter-output": adapter,
    "--smoke-input": smokeInput,
    "--smoke-output": smokeOutput,
    "--source-coordinate": sourceCoordinate,
    "--diagnostics": diagnostics,
    "--adapter": "scripts/demo-adapter",
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
    "--output": gate,
  });
  const gateRoot = verifyChecksums(gate);
  verifyGate({
    "--bundle": gate,
    "--expected-root": gateRoot,
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
  });

  writeRendererOutput(fullOutput, {
    transcript: path.join(gate, "complete-transcript.txt"),
    projection: path.join(gate, "public-projection.json"),
    scene: path.join(gate, "scene.json"),
  });
  finalizeMedia({
    "--gate-bundle": gate,
    "--gate-root": gateRoot,
    "--render-output": fullOutput,
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
    "--output": media,
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(media, "media-receipt.json"), "utf8")).qualifiedGateRoot, gateRoot);
  assert.match(verifyChecksums(media), /^sha256:[0-9a-f]{64}$/);

  fs.writeFileSync(path.join(gate, "scene.json"), "{}\n");
  assert.throws(
    () => verifyGate({
      "--bundle": gate,
      "--expected-root": gateRoot,
      "--renderer-image": RENDERER_IMAGE,
      "--source-sha": SOURCE_SHA,
    }),
    /checksum mismatch/,
  );
});
