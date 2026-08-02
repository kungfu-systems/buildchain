import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { adaptCapture, materializeDemo, validateScenario } from "../scripts/auditable-demo-platform.mjs";

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
    id, argv, timeoutSeconds: 10, expectedExitCodes: [0], stdoutIncludes, fileAssertions,
  });
  return {
    schema: "buildchain.declarative-binary-demo/v1",
    product: { id: "fixture", displayName: "Fixture CLI", binaryName: "fixture" },
    artifact: { platformId: "linux-x64", binaryPath: "fixture", metadataPath: "fixture.json", metadataContract: "fixture.binary/v1", runtimeDependencies: [] },
    execution: { deterministic: true, network: "none", secrets: "none", totalTimeoutSeconds: 30, environment: {} },
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

function fixture(t) {
  const root = temporary(t);
  const artifact = path.join(root, "artifact");
  fs.mkdirSync(artifact);
  const binary = path.join(artifact, "fixture");
  fs.writeFileSync(binary, `#!/usr/bin/env python3
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
  time.sleep(0.18)
  print("\\x1b[38;5;81mINDEPENDENT END\\x1b[0m", flush=True)
elif sys.argv[1:] == ["slow"]:
  time.sleep(2)
  print("SLOW COMPLETE")
else:
  raise SystemExit(2)
`);
  fs.chmodSync(binary, 0o755);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  writeJson(path.join(artifact, "fixture.json"), { contract: "fixture.binary/v1", platformId: "linux-x64", sha256: digest, runtimeDependencies: [] });
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
  return { root, artifact, scenarioPath, coordinate };
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
  assert.deepEqual(validateScenario(scenario()).demos.map((entry) => entry.id), ["shared-state", "independent"]);
  const invalid = structuredClone(scenario());
  invalid.demos[0].steps[0].command = "fixture write";
  assert.throws(() => validateScenario(invalid), /command is not allowed|must not use a shell/u);
  const privileged = structuredClone(scenario());
  privileged.authority.grants.push("system-identity");
  assert.throws(() => validateScenario(privileged), /authority boundary/u);
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
  const gateCheck = spawnSync(process.execPath, [
    path.join(ROOT, "scripts/auditable-demo.mjs"), "prepare-smoke",
    "--adapter-output", adapted,
    "--output", path.join(root, "smoke"),
  ], { encoding: "utf8" });
  assert.equal(gateCheck.status, 0, gateCheck.stderr);
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
  const value = capture(t, "shared-state");
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
  writeJson(path.join(media, "gate-receipt.json"), { schema: "buildchain.auditable-demo-gate/v1", status: "passed" });
  writeJson(path.join(media, "media-receipt.json"), {
    schema: "buildchain.auditable-demo-media/v2",
    status: "passed",
    qualifiedGateRoot: gateRoot,
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
  const firstReadme = fs.readFileSync(path.join(repository, "README.md"), "utf8");
  const second = materializeDemo(args);
  assert.equal(second.evidenceRoot, first.evidenceRoot);
  assert.equal(fs.readFileSync(path.join(repository, "README.md"), "utf8"), firstReadme);
  assert.match(firstReadme, /\$ fixture write[\s\S]*\$ fixture read/u);
  assert.match(firstReadme, /1080p MP4[\s\S]*720p MP4/u);
  const independent = capture(t, "independent");
  materializeDemo({
    ...args,
    demoId: "independent",
    scenarioPath: independent.scenarioPath,
    captureRoot: independent.output,
  });
  const multiReadme = fs.readFileSync(path.join(repository, "README.md"), "utf8");
  assert.match(multiReadme, /<!-- fixture-demo:shared-state:start -->/u);
  assert.match(multiReadme, /<!-- fixture-demo:independent:start -->/u);
  assert.match(multiReadme, /\$ fixture write/u);
  assert.match(multiReadme, /\$ fixture independent/u);
  const passport = JSON.parse(fs.readFileSync(path.join(repository, first.evidenceDirectory, "release-passport.json"), "utf8"));
  assert.deepEqual(passport.authority.grants, []);
  assert.equal(passport.authority.productSystemRole, "assembly-and-distribution-metadata-only");
  fs.appendFileSync(path.join(media, "demo.gif"), "drift");
  assert.throws(() => materializeDemo(args), /checksum mismatch/u);
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
});

test("recursive dogfood resolves the reviewed setup-node action commit", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/auditable-demo.yml"), "utf8");
  assert.match(
    workflow,
    /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6\.4\.0/u,
  );
});
