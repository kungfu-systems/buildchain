import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { adaptCapture, materializeDemo, prepareArtifact, validateScenario } from "../scripts/auditable-demo-platform.mjs";
import { runTransportSmoke } from "../scripts/auditable-demo-transport-smoke.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const NON_AUTHORITIES = [
  "first-party-identity", "system-identity", "kfd-compliance", "product-system-metadata",
  "package-metadata", "registry-history", "scan-output", "standalone-generation",
];
const RENDITIONS = [
  { id: "1080p", role: "primary", columns: 150, rows: 36, width: 1920, height: 1080 },
  { id: "720p", role: "responsive", columns: 100, rows: 28, width: 1280, height: 720 },
];

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-demo-platform-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function writeChecksums(root) {
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "checksums.sha256")
    .map((entry) => entry.name)
    .sort();
  const bytes = `${names.map((name) => `${sha256(fs.readFileSync(path.join(root, name))).slice(7)}  ${name}`).join("\n")}\n`;
  fs.writeFileSync(path.join(root, "checksums.sha256"), bytes);
  return sha256(Buffer.from(bytes));
}

function scenario() {
  const step = (id, argv, stdoutIncludes, fileAssertions = []) => ({
    id, argv, timeoutSeconds: 20, expectedExitCodes: [0], stdoutIncludes, fileAssertions,
  });
  return {
    schema: "buildchain.declarative-binary-demo/v1",
    compositionMode: "terminal-fill",
    product: { id: "fixture", displayName: "Fixture CLI", binaryName: "fixture" },
    artifact: { platformId: "linux-x64", binaryPath: "fixture", metadataPath: "fixture.json", metadataContract: "fixture.binary/v1", runtimeDependencies: [] },
    execution: { deterministic: true, network: "none", secrets: "none", totalTimeoutSeconds: 30, environment: {} },
    transportSmoke: { argv: ["independent"], timeoutSeconds: 20, expectedExitCodes: [0], stdoutIncludes: ["INDEPENDENT END"] },
    renditions: RENDITIONS,
    demos: [
      {
        id: "shared-state", title: "Shared state", claimBoundary: "The fixture proves only declared local state sharing.",
        steps: [
          step("write", ["write"], ["STATE WRITTEN"]),
          step("read", ["read"], ["STATE READ"], [{ path: "state.json", jsonEquals: { status: "ready" } }]),
        ],
      },
      {
        id: "independent", title: "Independent demo", claimBoundary: "The fixture proves only independent demo workspaces.",
        steps: [step("independent", ["independent"], ["INDEPENDENT"])],
      },
    ],
    publication: { evidencePath: "docs/evidence/auditable-demo", readmePath: "README.md", marker: "fixture-demo" },
    authority: { grants: [], nonAuthorities: NON_AUTHORITIES },
  };
}

function declareLongForm(value) {
  value.execution.durationClass = "long-form";
  value.execution.totalTimeoutSeconds = 180;
  for (const demo of value.demos) {
    for (const step of demo.steps) step.timeoutSeconds = 180;
  }
}

function declarePresentation(value) {
  declareLongForm(value);
  value.presentation = {
    schema: "buildchain.declarative-demo-presentation/v1",
    proofs: value.demos.map((demo, index) => ({
      demoId: demo.id,
      label: index === 0 ? "Continuity" : "Failure retention",
      question: demo.title,
      summary: index === 0
        ? "The first proof isolates continuity across sessions."
        : "The second proof places continuity under failure.",
      ...(index === 0 ? { transitionAfter: "Continuity must also survive failure." } : {}),
    })),
    materialization: {
      readmeMode: "media-only",
      technicalSpecPath: "docs/demo-technical-spec.md",
      technicalSpecTitle: "Fixture demo technical specification",
      technicalMarker: "fixture-demo:technical",
    },
  };
}

function oversizedLongFormRendererManifest() {
  const replay = "x".repeat(4 * 1024 * 1024);
  return {
    schema: "build-images.auditable-demo-render/v1",
    renderer: { image: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"e".repeat(64)}` },
    inputs: {
      renditions: [
        { id: "1080p", role: "primary", width: 1920, height: 1080 },
        { id: "720p", role: "responsive", width: 1280, height: 720 },
      ].map((rendition, index) => ({
        id: rendition.id,
        role: rendition.role,
        scene: { path: { durationClass: "long-form", durationMs: 180_000, fps: 10, width: rendition.width, height: rendition.height } },
        terminalCapture: {
          schema: "kungfu.terminal-capture/v1",
          root: `sha256:${(index === 0 ? "c" : "d").repeat(64)}`,
          durationMs: 179_000,
          events: 10_000,
          bytes: 4 * 1024 * 1024,
          path: { normalizedReplay: replay },
        },
      })),
    },
    outputs: {},
  };
}

function fixture(t) {
  const root = temporary(t);
  const artifact = path.join(root, "artifact");
  fs.mkdirSync(path.join(artifact, "runtime"), { recursive: true });
  const binary = path.join(artifact, "fixture");
  const runtime = path.join(artifact, "runtime", "fixture-runtime");
  fs.writeFileSync(binary, `#!/bin/sh
exec "$(dirname "$0")/runtime/fixture-runtime" "$@"
`);
  fs.writeFileSync(runtime, `#!/usr/bin/env python3
import json, os, sys, time
if sys.argv[1:] == ["write"]:
  open("state.json", "w", encoding="utf-8").write(json.dumps({"status":"ready"}))
  print("\\x1b[38;5;42mSTATE WRITTEN\\x1b[0m")
elif sys.argv[1:] == ["read"]:
  assert json.load(open("state.json", encoding="utf-8"))["status"] == "ready"
  print("\\x1b[38;5;81mSTATE READ\\x1b[0m")
elif sys.argv[1:] == ["independent"]:
  assert not os.path.exists("state.json")
  print("\\x1b[38;5;214mINDEPENDENT START\\x1b[0m", flush=True)
  time.sleep(float(os.environ.get("FIXTURE_DELAY", "0.18")))
  print("\\x1b[38;5;81mINDEPENDENT END\\x1b[0m", flush=True)
elif sys.argv[1:] == ["slow"]:
  time.sleep(2)
  print("SLOW COMPLETE")
else:
  raise SystemExit(2)
`);
  fs.chmodSync(binary, 0o755);
  fs.chmodSync(runtime, 0o755);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const runtimeDigest = crypto.createHash("sha256").update(fs.readFileSync(runtime)).digest("hex");
  writeJson(path.join(artifact, "fixture.json"), {
    contract: "fixture.binary/v1",
    platformId: "linux-x64",
    sha256: `sha256:${digest}`,
    executableFiles: [
      { path: "fixture", sha256: digest },
      { path: "runtime/fixture-runtime", sha256: runtimeDigest },
    ],
    runtimeDependencies: [],
  });
  const scenarioPath = path.join(root, "scenario.json");
  writeJson(scenarioPath, scenario());
  const coordinate = path.join(root, "coordinate.json");
  writeJson(coordinate, {
    schema: "buildchain.github-artifact-coordinate/v1",
    repository: "kungfu-systems/fixture",
    runId: "42",
    runAttempt: "1",
    sourceSha: "a".repeat(40),
    id: "99",
    nodeId: "artifact-node",
    name: "fixture-linux-x64",
    digest: `sha256:${"b".repeat(64)}`,
    sizeInBytes: 1024,
    createdAt: "2026-08-02T00:00:00Z",
    expiresAt: "2026-08-16T00:00:00Z",
  });
  return { root, artifact, binary, runtime, scenarioPath, coordinate };
}

function capture(t, demoId, transformScenario = null) {
  const value = fixture(t);
  if (transformScenario) {
    const declared = JSON.parse(fs.readFileSync(value.scenarioPath, "utf8"));
    transformScenario(declared);
    writeJson(value.scenarioPath, declared);
  }
  const output = path.join(value.root, `capture-${demoId}`);
  const result = spawnSync("python3", [
    path.join(ROOT, "scripts/auditable-demo-capture.py"),
    "--artifact-root", value.artifact,
    "--scenario", value.scenarioPath,
    "--source-coordinate", value.coordinate,
    "--demo-id", demoId,
    "--network-isolation", "test-only",
    "--output", output,
  ], { encoding: "utf8", env: { ...process.env, BUILDCHAIN_AUDITABLE_DEMO_TEST: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return { ...value, output };
}

test("scenario contract accepts multiple demos and rejects shell command authority", () => {
  const admitted = validateScenario(scenario());
  assert.deepEqual(admitted.demos.map((entry) => entry.id), ["shared-state", "independent"]);
  assert.equal(admitted.compositionMode, "terminal-fill");
  const invalid = structuredClone(scenario());
  invalid.demos[0].steps[0].command = "fixture write";
  assert.throws(() => validateScenario(invalid), /command is not allowed|must not use a shell/u);
  const privileged = structuredClone(scenario());
  privileged.authority.grants.push("system-identity");
  assert.throws(() => validateScenario(privileged), /authority boundary/u);
  const invalidComposition = structuredClone(scenario());
  invalidComposition.compositionMode = "cropped-terminal";
  assert.throws(() => validateScenario(invalidComposition), /composition mode/u);

  const readable = structuredClone(scenario());
  readable.playback = {
    schema: "buildchain.declarative-demo-playback/v1",
    mode: "deterministic-readable",
    activeDurationMs: 1600,
    finalHoldMs: 700,
  };
  assert.equal(validateScenario(readable).playback.activeDurationMs, 1600);
  readable.playback.finalHoldMs = 60_000;
  assert.throws(() => validateScenario(readable), /final hold|duration class/u);
});

test("optional presentation binds consumer proof semantics without changing the legacy default", () => {
  const legacy = scenario();
  assert.equal(validateScenario(legacy).presentation, undefined);

  const presented = structuredClone(legacy);
  declarePresentation(presented);
  assert.equal(validateScenario(presented).presentation.materialization.readmeMode, "media-only");

  const reordered = structuredClone(presented);
  [reordered.presentation.proofs[0], reordered.presentation.proofs[1]] = [reordered.presentation.proofs[1], reordered.presentation.proofs[0]];
  assert.throws(() => validateScenario(reordered), /preserve demo order/u);

  const divergentQuestion = structuredClone(presented);
  divergentQuestion.presentation.proofs[0].question = "A different product claim?";
  assert.throws(() => validateScenario(divergentQuestion), /must equal the demo title/u);
});

test("duration class keeps standard at 60 seconds and admits only bounded long-form", () => {
  const standardTotal = structuredClone(scenario());
  standardTotal.execution.totalTimeoutSeconds = 61;
  assert.throws(() => validateScenario(standardTotal), /total timeout/u);

  const standardStep = structuredClone(scenario());
  standardStep.demos[0].steps[0].timeoutSeconds = 61;
  assert.throws(() => validateScenario(standardStep), /timeoutSeconds/u);

  const longForm = structuredClone(scenario());
  longForm.execution.durationClass = "long-form";
  longForm.execution.totalTimeoutSeconds = 180;
  longForm.demos[0].steps[0].timeoutSeconds = 180;
  assert.equal(validateScenario(longForm).execution.durationClass, "long-form");

  longForm.execution.totalTimeoutSeconds = 181;
  assert.throws(() => validateScenario(longForm), /total timeout/u);
  longForm.execution.totalTimeoutSeconds = 180;
  longForm.demos[0].steps[0].timeoutSeconds = 181;
  assert.throws(() => validateScenario(longForm), /timeoutSeconds/u);

  const unboundedSmoke = structuredClone(scenario());
  unboundedSmoke.transportSmoke.timeoutSeconds = 61;
  assert.throws(() => validateScenario(unboundedSmoke), /transport smoke timeout/u);
});

test("artifact preparation restores only the exact digest-bound executable closure", { skip: process.platform === "win32" }, (t) => {
  const value = fixture(t);
  const inert = path.join(value.artifact, "inert-data");
  fs.writeFileSync(inert, "not executable\n");
  fs.chmodSync(value.binary, 0o644);
  fs.chmodSync(value.runtime, 0o644);
  fs.chmodSync(inert, 0o644);

  const result = prepareArtifact({ artifactRoot: value.artifact, scenarioPath: value.scenarioPath });
  assert.deepEqual(result.executableFiles.map((entry) => entry.path), ["fixture", "runtime/fixture-runtime"]);
  assert.notEqual(fs.statSync(value.binary).mode & 0o111, 0);
  assert.notEqual(fs.statSync(value.runtime).mode & 0o111, 0);
  assert.equal(fs.statSync(inert).mode & 0o111, 0, "undeclared files remain untouched");
  assert.deepEqual(result.authority.grants, []);
});

test("artifact preparation rejects unsafe or digest-drifted executable declarations", (t) => {
  const unsafe = fixture(t);
  const unsafeMetadataPath = path.join(unsafe.artifact, "fixture.json");
  const unsafeMetadata = JSON.parse(fs.readFileSync(unsafeMetadataPath, "utf8"));
  unsafeMetadata.executableFiles[1].path = "../fixture-runtime";
  writeJson(unsafeMetadataPath, unsafeMetadata);
  assert.throws(
    () => prepareArtifact({ artifactRoot: unsafe.artifact, scenarioPath: unsafe.scenarioPath }),
    /escapes its root/u,
  );

  const drifted = fixture(t);
  const driftedMetadataPath = path.join(drifted.artifact, "fixture.json");
  const driftedMetadata = JSON.parse(fs.readFileSync(driftedMetadataPath, "utf8"));
  driftedMetadata.executableFiles[1].sha256 = "0".repeat(64);
  writeJson(driftedMetadataPath, driftedMetadata);
  assert.throws(
    () => prepareArtifact({ artifactRoot: drifted.artifact, scenarioPath: drifted.scenarioPath }),
    /digest differs/u,
  );
});

test("pre-upload transport smoke catches an omitted executable before artifact upload", { skip: process.platform === "win32" }, (t) => {
  const qualified = fixture(t);
  const receipt = runTransportSmoke({ artifactRoot: qualified.artifact, scenarioPath: qualified.scenarioPath });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.exitCode, 0);
  assert.deepEqual(receipt.authority.grants, []);

  const incomplete = fixture(t);
  const metadataPath = path.join(incomplete.artifact, "fixture.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.executableFiles = metadata.executableFiles.slice(0, 1);
  writeJson(metadataPath, metadata);
  assert.throws(
    () => runTransportSmoke({ artifactRoot: incomplete.artifact, scenarioPath: incomplete.scenarioPath }),
    /transport smoke exited with|Permission denied/u,
  );
});

test("capture shares ordered state within a demo and creates independent native renditions", { skip: process.platform === "win32" }, (t) => {
  const { output } = capture(t, "shared-state");
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "qualified");
  assert.equal(manifest.networkIsolation, "test-only");
  assert.deepEqual(manifest.renditions.map(({ columns, rows }) => [columns, rows]), [[150, 36], [100, 28]]);
  assert.notEqual(manifest.renditions[0].terminalCaptureRoot, manifest.renditions[1].terminalCaptureRoot);
  const captureValue = JSON.parse(fs.readFileSync(path.join(output, "renditions/1080p/terminal-capture.json"), "utf8"));
  assert.equal(captureValue.events.some((event) => Buffer.from(event.data, "base64").includes(Buffer.from("\u001b[38;5;42m"))), true, "ANSI color bytes remain in the capture");
  assert.equal(fs.existsSync(path.join(output, "renditions/1080p/workspace")), false);
});

test("generic adapter projects exact captures into the existing Gate contract", { skip: process.platform === "win32" }, (t) => {
  const { root, output } = capture(t, "shared-state");
  const adapted = path.join(root, "adapted");
  const result = adaptCapture({ artifactRoot: output, output: adapted });
  assert.equal(result.demoId, "shared-state");
  assert.notEqual(result.renditionRoots[0], result.renditionRoots[1]);
  const set = JSON.parse(fs.readFileSync(path.join(adapted, "rendition-set.json"), "utf8"));
  assert.deepEqual(set.renditions.map(({ id, role }) => [id, role]), [["1080p", "primary"], ["720p", "responsive"]]);
  for (const name of ["scene.json", "scene-720p.json"]) {
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(adapted, name), "utf8")).compositionMode,
      "terminal-fill",
    );
  }
  const gateCheck = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/auditable-demo.mjs"), "prepare-smoke",
    "--adapter-output", adapted,
    "--output", path.join(root, "smoke"),
  ], { encoding: "utf8" });
  assert.equal(gateCheck.status, 0, gateCheck.stderr);
});

test("omitting composition preserves the presentation-framed adapter default", { skip: process.platform === "win32" }, (t) => {
  const { root, output } = capture(t, "shared-state", (declared) => {
    delete declared.compositionMode;
  });
  const adapted = path.join(root, "adapted-default-composition");
  adaptCapture({ artifactRoot: output, output: adapted });
  for (const name of ["scene.json", "scene-720p.json"]) {
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(adapted, name), "utf8")).compositionMode,
      "presentation-framed",
    );
  }
});

test("declared readable playback normalizes latency without changing terminal payloads or order", { skip: process.platform === "win32" }, (t) => {
  const declarePlayback = (delay) => (declared) => {
    declared.execution.environment.FIXTURE_DELAY = delay;
    declared.playback = {
      schema: "buildchain.declarative-demo-playback/v1",
      mode: "deterministic-readable",
      activeDurationMs: 1600,
      finalHoldMs: 700,
    };
  };
  const fast = capture(t, "independent", declarePlayback("0.05"));
  const slow = capture(t, "independent", declarePlayback("0.35"));
  const readCapture = ({ output }) => JSON.parse(fs.readFileSync(path.join(output, "renditions/1080p/terminal-capture.json"), "utf8"));
  const fastCapture = readCapture(fast);
  const slowCapture = readCapture(slow);
  assert.deepEqual(fastCapture.events.map((event) => event.data), slowCapture.events.map((event) => event.data));
  assert.deepEqual(fastCapture.events.map((event) => event.atMs), slowCapture.events.map((event) => event.atMs));
  assert.equal(fastCapture.durationMs, 2300);
  assert.equal(fastCapture.playback.eventOrder, "preserved");
  assert.ok(slowCapture.playback.observedLastEventMs >= 300, "the slower PTY latency remains recorded as evidence");

  const adapted = path.join(fast.root, "adapted-readable");
  adaptCapture({ artifactRoot: fast.output, output: adapted });
  const projected = JSON.parse(fs.readFileSync(path.join(adapted, "terminal-capture.json"), "utf8"));
  const scene = JSON.parse(fs.readFileSync(path.join(adapted, "scene.json"), "utf8"));
  assert.equal(projected.durationMs, 2300);
  assert.equal(scene.durationMs, 2300, "declared final hold is not extended by an implicit adapter hold");
});

test("generic adapter projects an explicit long-form renderer contract", { skip: process.platform === "win32" }, (t) => {
  const { root, output } = capture(t, "independent", (declared) => {
    declared.execution.durationClass = "long-form";
    declared.execution.totalTimeoutSeconds = 180;
    declared.demos[1].steps[0].timeoutSeconds = 180;
  });
  const adapted = path.join(root, "adapted-long-form");
  adaptCapture({ artifactRoot: output, output: adapted });
  for (const name of ["scene.json", "scene-720p.json"]) {
    const projected = JSON.parse(fs.readFileSync(path.join(adapted, name), "utf8"));
    assert.equal(projected.durationClass, "long-form");
    assert.equal(projected.fps, 10);
    assert.ok(projected.durationMs <= 180_000);
  }
  const primary = JSON.parse(fs.readFileSync(path.join(adapted, "terminal-capture.json"), "utf8"));
  const responsive = JSON.parse(fs.readFileSync(path.join(adapted, "terminal-capture-720p.json"), "utf8"));
  assert.equal(primary.durationMs, responsive.durationMs, "native replay windows share one exact duration");
});

test("capture keeps demos isolated and fails closed on binary metadata drift", { skip: process.platform === "win32" }, (t) => {
  const independent = capture(t, "independent");
  assert.equal(JSON.parse(fs.readFileSync(path.join(independent.output, "manifest.json"), "utf8")).demo.id, "independent");
  const timedCapture = JSON.parse(fs.readFileSync(path.join(independent.output, "renditions/1080p/terminal-capture.json"), "utf8"));
  const start = timedCapture.events.find((event) => Buffer.from(event.data, "base64").includes(Buffer.from("INDEPENDENT START")));
  const end = timedCapture.events.find((event) => Buffer.from(event.data, "base64").includes(Buffer.from("INDEPENDENT END")));
  assert.ok(start && end, "timed PTY chunks are retained");
  assert.ok(end.atMs - start.atMs >= 120, `PTY timing collapsed to ${end.atMs - start.atMs}ms`);
  const drifted = fixture(t);
  const metadata = JSON.parse(fs.readFileSync(path.join(drifted.artifact, "fixture.json"), "utf8"));
  metadata.sha256 = "0".repeat(64);
  writeJson(path.join(drifted.artifact, "fixture.json"), metadata);
  const result = spawnSync("python3", [
    path.join(ROOT, "scripts/auditable-demo-capture.py"), "--artifact-root", drifted.artifact,
    "--scenario", drifted.scenarioPath, "--source-coordinate", drifted.coordinate,
    "--demo-id", "shared-state", "--network-isolation", "test-only", "--output", path.join(drifted.root, "drifted"),
  ], { encoding: "utf8", env: { ...process.env, BUILDCHAIN_AUDITABLE_DEMO_TEST: "1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /binary digest differs/u);
});

test("capture enforces the total deadline inside a running step", { skip: process.platform === "win32" }, (t) => {
  const value = fixture(t);
  const declared = JSON.parse(fs.readFileSync(value.scenarioPath, "utf8"));
  declared.execution.totalTimeoutSeconds = 1;
  declared.demos = [{
    id: "slow",
    title: "Slow fixture",
    claimBoundary: "The negative fixture must be stopped by the exact total deadline.",
    steps: [{
      id: "slow",
      argv: ["slow"],
      timeoutSeconds: 10,
      expectedExitCodes: [0],
      stdoutIncludes: ["SLOW COMPLETE"],
      fileAssertions: [],
    }],
  }];
  writeJson(value.scenarioPath, declared);
  const started = Date.now();
  const result = spawnSync("python3", [
    path.join(ROOT, "scripts/auditable-demo-capture.py"),
    "--artifact-root", value.artifact,
    "--scenario", value.scenarioPath,
    "--source-coordinate", value.coordinate,
    "--demo-id", "slow",
    "--network-isolation", "test-only",
    "--output", path.join(value.root, "slow-capture"),
  ], { encoding: "utf8", env: { ...process.env, BUILDCHAIN_AUDITABLE_DEMO_TEST: "1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /step exceeded its .*second bound|total timeout/u);
  assert.ok(Date.now() - started < 4_000, "total timeout was not enforced while the step was running");
});

test("materializer verifies exact bundles and updates README idempotently", { skip: process.platform === "win32" }, (t) => {
  const value = capture(t, "shared-state", declareLongForm);
  const repository = path.join(value.root, "consumer");
  const gate = path.join(value.root, "gate");
  const media = path.join(value.root, "media");
  fs.mkdirSync(repository);
  fs.mkdirSync(gate);
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(repository, "README.md"), "# Fixture consumer\n\nExisting content.\n");
  writeJson(path.join(gate, "gate-receipt.json"), { schema: "buildchain.auditable-demo-gate/v1", status: "passed" });
  const gateRoot = writeChecksums(gate);
  for (const name of ["demo.gif", "demo.mp4", "demo.webm", "demo-720p.mp4", "demo-720p.webm", "poster.png", "manifest.json", "media-probe.json", "media-inspection.json", "renderer-checksums.sha256"]) {
    fs.writeFileSync(path.join(media, name), Buffer.from(`fixture:${name}\n`));
  }
  const rendererManifest = Buffer.from(`${JSON.stringify(oversizedLongFormRendererManifest(), null, 2)}\n`);
  assert.ok(rendererManifest.length > 8 * 1024 * 1024);
  fs.writeFileSync(path.join(media, "manifest.json"), rendererManifest);
  fs.writeFileSync(path.join(media, "demo.mp4"), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  writeJson(path.join(media, "gate-receipt.json"), { schema: "buildchain.auditable-demo-gate/v1", status: "passed" });
  writeJson(path.join(media, "media-receipt.json"), {
    schema: "buildchain.auditable-demo-media/v2",
    status: "passed",
    qualifiedGateRoot: gateRoot,
    rendererManifestRoot: sha256(rendererManifest),
    qualification: { profile: { id: "responsive-web-delivery-v1" }, qualificationRoot: `sha256:${"c".repeat(64)}` },
    qualificationRoot: `sha256:${"c".repeat(64)}`,
  });
  writeChecksums(media);
  const args = {
    repositoryRoot: repository,
    scenarioPath: value.scenarioPath,
    demoId: "shared-state",
    captureRoot: value.output,
    gateBundle: gate,
    mediaBundle: media,
    buildchainSha: "d".repeat(40),
    rendererImage: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"e".repeat(64)}`,
  };
  const first = materializeDemo(args);
  assert.ok(fs.statSync(path.join(repository, first.evidenceDirectory, "demo.mp4")).size > 8 * 1024 * 1024);
  assert.ok(fs.statSync(path.join(repository, first.evidenceDirectory, "manifest.json")).size > 8 * 1024 * 1024);
  const firstReadme = fs.readFileSync(path.join(repository, "README.md"), "utf8");
  const second = materializeDemo(args);
  assert.equal(second.evidenceRoot, first.evidenceRoot);
  assert.equal(fs.readFileSync(path.join(repository, "README.md"), "utf8"), firstReadme);
  assert.match(firstReadme, /\$ fixture write[\s\S]*\$ fixture read/u);
  assert.match(firstReadme, /1080p MP4[\s\S]*720p MP4/u);

  const legacyBlock = firstReadme.match(/<!-- fixture-demo:shared-state:start -->[\s\S]*?<!-- fixture-demo:shared-state:end -->/u)?.[0];
  assert.ok(legacyBlock);
  fs.writeFileSync(path.join(repository, "README.md"), [
    "# Fixture consumer",
    "",
    "## Three consumer-owned proofs",
    "",
    "### Can Work survive a new Agent?",
    "",
    "Human-authored narrative stays outside the generated marker.",
    "",
    legacyBlock,
    "",
    "The bridge to the next proof also remains consumer-owned.",
    "",
  ].join("\n"));
  const presented = capture(t, "shared-state", declarePresentation);
  const presentedArgs = {
    ...args,
    scenarioPath: presented.scenarioPath,
    captureRoot: presented.output,
  };
  const presentedFirst = materializeDemo(presentedArgs);
  assert.equal(presentedFirst.technicalSpecPath, "docs/demo-technical-spec.md");
  const presentedReadme = fs.readFileSync(path.join(repository, "README.md"), "utf8");
  assert.match(presentedReadme, /Human-authored narrative stays outside the generated marker/u);
  assert.match(presentedReadme, /The bridge to the next proof also remains consumer-owned/u);
  const presentedBlock = presentedReadme.match(/<!-- fixture-demo:shared-state:start -->[\s\S]*?<!-- fixture-demo:shared-state:end -->/u)?.[0] || "";
  assert.match(presentedBlock, /\[!\[Shared state\]/u);
  assert.doesNotMatch(presentedBlock, /Animation scenario|Native renditions|<details>/u);
  const technicalSpec = fs.readFileSync(path.join(repository, "docs/demo-technical-spec.md"), "utf8");
  assert.match(technicalSpec, /## Continuity: Shared state/u);
  assert.match(technicalSpec, /\$ fixture write[\s\S]*\$ fixture read/u);
  assert.match(technicalSpec, /Native renditions:[\s\S]*Claim boundary:/u);
  assert.match(technicalSpec, /Continuity must also survive failure\./u);
  assert.ok(technicalSpec.indexOf("fixture-demo:technical:shared-state:start") < technicalSpec.indexOf("fixture-demo:technical:independent:start"));
  materializeDemo(presentedArgs);
  assert.equal(fs.readFileSync(path.join(repository, "README.md"), "utf8"), presentedReadme);
  assert.equal(fs.readFileSync(path.join(repository, "docs/demo-technical-spec.md"), "utf8"), technicalSpec);

  const independent = capture(t, "independent", declareLongForm);
  materializeDemo({
    ...args,
    demoId: "independent",
    scenarioPath: independent.scenarioPath,
    captureRoot: independent.output,
  });
  const multiReadme = fs.readFileSync(path.join(repository, "README.md"), "utf8");
  assert.match(multiReadme, /<!-- fixture-demo:shared-state:start -->/u);
  assert.match(multiReadme, /<!-- fixture-demo:independent:start -->/u);
  assert.match(multiReadme, /Human-authored narrative stays outside the generated marker/u);
  assert.match(multiReadme, /\$ fixture independent/u);
  const passport = JSON.parse(fs.readFileSync(path.join(repository, first.evidenceDirectory, "release-passport.json"), "utf8"));
  assert.deepEqual(passport.authority.grants, []);
  assert.equal(passport.authority.productSystemRole, "assembly-and-distribution-metadata-only");
  const standard = capture(t, "shared-state");
  assert.throws(() => materializeDemo({
    ...args,
    scenarioPath: standard.scenarioPath,
    captureRoot: standard.output,
  }), /media bundle member must be a bounded regular file/u);

  const checksumsPath = path.join(media, "checksums.sha256");
  const validChecksums = fs.readFileSync(checksumsPath);
  const firstChecksum = validChecksums.toString("utf8").split("\n")[0];
  fs.appendFileSync(checksumsPath, `${firstChecksum}\n`);
  assert.throws(() => materializeDemo(args), /checksum member is repeated/u);
  fs.writeFileSync(checksumsPath, validChecksums);

  fs.appendFileSync(checksumsPath, `${"0".repeat(64)}  ../escape\n`);
  assert.throws(() => materializeDemo(args), /checksum member escapes its root/u);
  fs.writeFileSync(checksumsPath, validChecksums);

  fs.writeFileSync(path.join(media, "undeclared.bin"), "undeclared");
  assert.throws(() => materializeDemo(args), /checksum member set is not exact/u);
  fs.rmSync(path.join(media, "undeclared.bin"));

  fs.symlinkSync(path.join(media, "demo.gif"), path.join(media, "linked.gif"));
  assert.throws(() => materializeDemo(args), /bundle member must not be a symbolic link/u);
  fs.rmSync(path.join(media, "linked.gif"));

  const gifPath = path.join(media, "demo.gif");
  const gifBytes = fs.readFileSync(gifPath);
  fs.appendFileSync(path.join(media, "demo.gif"), "drift");
  assert.throws(() => materializeDemo(args), /checksum mismatch/u);
  fs.writeFileSync(gifPath, gifBytes);

  const mp4Path = path.join(media, "demo.mp4");
  const mp4Bytes = fs.statSync(mp4Path).size;
  fs.truncateSync(mp4Path, 64 * 1024 * 1024 + 1);
  assert.throws(() => materializeDemo(args), /media bundle member must be a bounded regular file/u);
  fs.truncateSync(mp4Path, mp4Bytes);

  fs.truncateSync(mp4Path, 64 * 1024 * 1024);
  fs.truncateSync(path.join(media, "demo.webm"), 64 * 1024 * 1024);
  assert.throws(() => materializeDemo(args), /media bundle exceeds its aggregate byte budget/u);
});

test("Gate smoke stays bounded while full render consumes both native captures", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/.declarative-auditable-demo.yml"), "utf8");
  const smoke = workflow.slice(
    workflow.indexOf("smoke-output:/output"),
    workflow.indexOf("smoke-inspection"),
  );
  const full = workflow.slice(
    workflow.indexOf("render-output:/output"),
    workflow.indexOf("render-inspection"),
  );
  assert.doesNotMatch(smoke, /--terminal-capture|--rendition-set/u);
  assert.match(full, /--terminal-capture \/input\/terminal-capture\.json/u);
  assert.match(full, /--rendition-set \/input\/rendition-set\.json/u);
  assert.match(workflow, /demo-renderer --validate-only[\s\S]*--rendition-set/u);
  assert.match(workflow, /prepare-artifact[\s\S]*--artifact-root "source-artifact"/u);
});

test("advisory media failure preserves the required Gate and suppresses publication", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/.declarative-auditable-demo.yml"), "utf8");
  const gateIndex = workflow.indexOf("name: Run required Gate for every declared demo");
  const renderIndex = workflow.indexOf("name: Render full media for every declared demo");
  assert.ok(gateIndex >= 0 && renderIndex > gateIndex);
  assert.match(workflow, /render-failure-advisory:[\s\S]*default: false[\s\S]*type: boolean/u);
  assert.match(workflow.slice(renderIndex, workflow.indexOf("name: Bind evidence collection identity", renderIndex)), /id: render[\s\S]*continue-on-error: \$\{\{ inputs\.render-failure-advisory \}\}/u);
  assert.match(workflow, /render-result: \$\{\{ steps\.render\.outcome \}\}/u);
  assert.match(workflow, /inputs\.materialize && inputs\.render-media && needs\.qualify\.outputs\.render-result == 'success'/u);
  assert.match(workflow, /The required Gate remains successful and no materialization PR will be opened/u);
});

test("declarative publication stages an optional consumer-owned technical specification", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/.declarative-auditable-demo.yml"), "utf8");
  assert.match(workflow, /technical_spec_path=.*technicalSpecPath/u);
  assert.match(workflow, /git add -- "\$\{technical_spec_path\}"/u);
});

test("reusable builds run the transport simulation before either artifact upload path", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/.build.yml"), "utf8");
  assert.equal(workflow.match(/name: Simulate artifact transport before upload/gu)?.length, 2);
  for (const start of [
    workflow.indexOf("name: Simulate artifact transport before upload"),
    workflow.lastIndexOf("name: Simulate artifact transport before upload"),
  ]) {
    const block = workflow.slice(start, workflow.indexOf("name: Upload deterministic artifact", start));
    assert.match(block, /auditable-demo-transport-smoke\.mjs/u);
    assert.match(block, /name: Upload payload to S3 artifact relay/u);
  }
});

test("recursive dogfood resolves the reviewed setup-node action commit", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/auditable-demo.yml"), "utf8");
  assert.match(
    workflow,
    /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\.4\.0/u,
  );
});
