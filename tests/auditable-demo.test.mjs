import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeGate,
  finalizeMedia,
  inspectIsoBmffFastStart,
  inspectRendererMedia,
  parseAdapterArguments,
  prepareSmoke,
  qualifyMediaFixture,
  runAdapter,
  sha256,
  stableJson,
  validateAdapterOutput,
  validateSourceCoordinate,
  verifyChecksums,
  verifyGate,
  verifyRendererOutput,
  writeChecksums,
} from "../scripts/auditable-demo.mjs";

const RENDERER_IMAGE = `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-auditable-demo-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function terminalCapture(durationMs = 2500) {
  const captureDurationMs = Math.max(500, durationMs - 500);
  return {
    schema: "kungfu.terminal-capture/v1",
    command: "kungfu agent-work-lab autoplay",
    dimensions: { columns: 120, rows: 36 },
    durationMs: captureDurationMs,
    encoding: "base64",
    events: [
      { atMs: 0, data: Buffer.from("\u001b[2J\u001b[HAgent Work Lab\r\n").toString("base64") },
      { atMs: Math.max(1, captureDurationMs - 1), data: Buffer.from("completed\r\n").toString("base64") },
    ],
    completion: {
      schema: "kungfu.agent-work-lab.tui-autoplay/v1",
      status: "qualified",
      reportRoot: `sha256:${"e".repeat(64)}`,
      eventCount: 4,
    },
    exitCode: 0,
    authority: {
      classification: "volatile-terminal-observation",
      grants: [],
      nonAuthorities: [
        "first-party-identity",
        "system-identity",
        "kfd-compliance",
        "product-system-metadata",
        "package-metadata",
        "registry-history",
        "scan-output",
        "standalone-generation",
      ],
    },
  };
}

function writeAdapterOutput(directory, durationMs = 2500, withCapture = false) {
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
    background: "#0B1020",
    accent: "#67E8A5",
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
  if (withCapture) {
    fs.writeFileSync(
      path.join(directory, "terminal-capture.json"),
      stableJson(terminalCapture(durationMs)),
    );
  }
}

function writeRendererOutput(directory, inputs) {
  fs.mkdirSync(directory, { recursive: true });
  const transcript = fs.readFileSync(inputs.transcript, "utf8").replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
  const sceneInput = JSON.parse(fs.readFileSync(inputs.scene, "utf8"));
  const projectionInput = JSON.parse(fs.readFileSync(inputs.projection, "utf8"));
  const scene = {
    ...sceneInput,
    commandLabel: sceneInput.commandLabel ?? "",
    background: (sceneInput.background ?? "#10151f").toLowerCase(),
    accent: (sceneInput.accent ?? "#67e8a5").toLowerCase(),
  };
  const projection = {
    ...projectionInput,
    cues: projectionInput.cues.map((cue) => ({ ...cue, annotation: cue.annotation ?? "" })),
  };
  fs.writeFileSync(path.join(directory, "complete-transcript.txt"), transcript);
  fs.writeFileSync(path.join(directory, "public-projection.json"), stableJson(projection));
  fs.writeFileSync(path.join(directory, "scene.json"), stableJson(scene));
  for (const name of ["demo.gif", "demo.mp4", "demo.webm", "poster.png"]) {
    const bytes = name === "demo.mp4"
      ? Buffer.concat([isoBox("ftyp"), isoBox("moov"), isoBox("mdat", Buffer.from("media"))])
      : Buffer.from(`${name}-fixture-data`);
    fs.writeFileSync(path.join(directory, name), bytes);
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
      {
        root: sha256(fs.readFileSync(path.join(directory, name))),
        bytes: fs.statSync(path.join(directory, name)).size,
      },
    ]),
  );
  fs.writeFileSync(path.join(directory, "manifest.json"), stableJson({
    schema: "build-images.auditable-demo-render/v1",
    renderer: { image: RENDERER_IMAGE },
    inputs: {
      scene: { root: sha256(fs.readFileSync(path.join(directory, "scene.json"))) },
      transcript: { root: sha256(fs.readFileSync(path.join(directory, "complete-transcript.txt"))) },
      projection: { root: sha256(fs.readFileSync(path.join(directory, "public-projection.json"))) },
      ...(inputs.terminalCapture
        ? {
          terminalCapture: {
            root: sha256(fs.readFileSync(inputs.terminalCapture)),
          },
        }
        : {}),
    },
    outputs,
  }));
  writeChecksums(directory);
}

function mediaInspection(overrides = {}) {
  const base = {
    "demo.mp4": {
      container: "mp4",
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      width: 1280,
      height: 720,
      durationMs: 2500,
      frameRate: 15,
      audioStreams: 0,
      progressiveDownload: "moov-before-mdat",
    },
    "demo.webm": {
      container: "webm",
      videoCodec: "vp9",
      pixelFormat: "yuv420p",
      width: 1280,
      height: 720,
      durationMs: 2500,
      frameRate: 15,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
    "demo.gif": {
      container: "gif",
      videoCodec: "gif",
      pixelFormat: "bgra",
      width: 1280,
      height: 720,
      durationMs: 2500,
      frameRate: 12,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
    "poster.png": {
      container: "png",
      videoCodec: "png",
      pixelFormat: "rgba",
      width: 1280,
      height: 720,
      durationMs: 0,
      frameRate: 0,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
  };
  const facts = Object.fromEntries(
    Object.entries(base).map(([name, value]) => [name, { ...value, ...(overrides[name] || {}) }]),
  );
  return (filePath) => facts[path.basename(filePath)];
}

function writeMediaInspectionWitness(filePath, renderOutput, overrides = {}) {
  const inspect = mediaInspection(overrides);
  const members = ["demo.gif", "demo.mp4", "demo.webm", "poster.png"].map((name) => {
    const bytes = fs.readFileSync(path.join(renderOutput, name));
    return {
      path: name,
      root: sha256(bytes),
      bytes: bytes.length,
      facts: inspect(path.join(renderOutput, name)),
    };
  });
  const body = {
    schema: "buildchain.auditable-demo-media-inspection/v1",
    rendererImage: RENDERER_IMAGE,
    members,
  };
  fs.writeFileSync(filePath, stableJson({ ...body, inspectionRoot: sha256(Buffer.from(stableJson(body))) }));
}

function isoBox(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
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
if (values["--demo-id"] !== "agent-work-lab") process.exit(10);
`);
  fs.chmodSync(adapter, 0o755);

  runAdapter({
    "--source-root": source,
    "--artifact-root": artifact,
    "--source-coordinate": coordinate,
    "--adapter": "adapter.mjs",
    "--adapter-arguments-json": '["--demo-id","agent-work-lab"]',
    "--output": output,
    "--diagnostics": diagnostics,
  });

  const execution = JSON.parse(
    fs.readFileSync(path.join(diagnostics, "adapter.json"), "utf8"),
  );
  assert.equal(execution.exitCode, 0);
  assert.deepEqual(execution.arguments, ["--demo-id", "agent-work-lab"]);
  assert.match(execution.argumentsRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(fs.readFileSync(path.join(output, "complete-transcript.txt"), "utf8"), "artifact qualified\n");
});

test("adapter argument vectors are bounded literal argv and cannot replace coordinates", () => {
  assert.deepEqual(
    parseAdapterArguments('["--demo-id","status-snapshot"]'),
    ["--demo-id", "status-snapshot"],
  );
  for (const [value, expected] of [
    ["not-json", /valid JSON/u],
    ['{"demo":"status"}', /must be an array/u],
    ['["--demo-id","line\\nbreak"]', /argument 1 is invalid/u],
    ['["--output","elsewhere"]', /reserved coordinate/u],
    [JSON.stringify(Array(33).fill("x")), /at most 32/u],
  ]) {
    assert.throws(() => parseAdapterArguments(value), expected);
  }
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

test("optional terminal capture is bounded and grants no implicit authority", (t) => {
  const root = temporaryDirectory(t);
  writeAdapterOutput(root, 2500, true);
  assert.equal(validateAdapterOutput(root).terminalCapture.schema, "kungfu.terminal-capture/v1");

  const capturePath = path.join(root, "terminal-capture.json");
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  capture.completion.status = "passed";
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /not a qualified Agent Work Lab autoplay/);

  capture.completion.status = "qualified";
  capture.authority.grants = ["system-identity"];
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /must not grant authority/);

  capture.authority.grants = [];
  capture.authority.nonAuthorities.pop();
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /must declare every identity and metadata non-authority/);

  capture.authority.nonAuthorities.push("standalone-generation");
  capture.events[0].atMs = 1;
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /must start at zero/);
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
  writeAdapterOutput(adapter, 2500, true);
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
  const gateReceipt = JSON.parse(fs.readFileSync(path.join(gate, "gate-receipt.json"), "utf8"));
  assert.equal(gateReceipt.qualifiedInputs.terminalCapture.schema, "kungfu.terminal-capture/v1");
  assert.equal(
    gateReceipt.qualifiedInputs.terminalCapture.root,
    sha256(fs.readFileSync(path.join(gate, "terminal-capture.json"))),
  );

  writeRendererOutput(fullOutput, {
    transcript: path.join(gate, "complete-transcript.txt"),
    projection: path.join(gate, "public-projection.json"),
    scene: path.join(gate, "scene.json"),
    terminalCapture: path.join(gate, "terminal-capture.json"),
  });
  finalizeMedia({
    "--gate-bundle": gate,
    "--gate-root": gateRoot,
    "--render-output": fullOutput,
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
    "--media-profile": "archive-v1",
    "--output": media,
  });
  const mediaReceipt = JSON.parse(fs.readFileSync(path.join(media, "media-receipt.json"), "utf8"));
  assert.equal(mediaReceipt.schema, "buildchain.auditable-demo-media/v1");
  assert.equal(mediaReceipt.qualifiedGateRoot, gateRoot);
  assert.equal(mediaReceipt.qualification, undefined);
  assert.equal(fs.existsSync(path.join(media, "terminal-capture.json")), false);
  assert.match(verifyChecksums(media), /^sha256:[0-9a-f]{64}$/);

  const webMedia = path.join(root, "web-media");
  const mediaInspectionPath = path.join(root, "media-inspection.json");
  writeMediaInspectionWitness(mediaInspectionPath, fullOutput);
  finalizeMedia({
    "--gate-bundle": gate,
    "--gate-root": gateRoot,
    "--render-output": fullOutput,
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
    "--media-profile": "web-delivery-v1",
    "--media-inspection": mediaInspectionPath,
    "--output": webMedia,
  });
  const webMediaReceipt = JSON.parse(fs.readFileSync(path.join(webMedia, "media-receipt.json"), "utf8"));
  assert.equal(webMediaReceipt.schema, "buildchain.auditable-demo-media/v2");
  assert.equal(webMediaReceipt.qualification.profile.id, "web-delivery-v1");
  assert.match(webMediaReceipt.qualificationRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(verifyChecksums(webMedia), /^sha256:[0-9a-f]{64}$/);

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

test("web-delivery qualification binds independently inspected rendition facts", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "input");
  const output = path.join(root, "render");
  writeAdapterOutput(input);
  writeRendererOutput(output, {
    transcript: path.join(input, "complete-transcript.txt"),
    projection: path.join(input, "public-projection.json"),
    scene: path.join(input, "scene.json"),
  });

  const result = verifyRendererOutput(output, RENDERER_IMAGE, {
    scene: path.join(output, "scene.json"),
    transcript: path.join(output, "complete-transcript.txt"),
    projection: path.join(output, "public-projection.json"),
  }, {
    mediaProfile: "web-delivery-v1",
    inspectMedia: mediaInspection(),
  });

  assert.equal(result.qualification.profile.id, "web-delivery-v1");
  assert.match(result.qualification.qualificationRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    result.qualification.renditions.map((entry) => entry.role),
    ["readme-compatibility", "primary-video", "alternate-video", "evidence-poster"],
  );
  assert.equal(result.qualification.renditions[1].videoCodec, "h264");
  assert.equal(result.qualification.renditions[1].progressiveDownload, "moov-before-mdat");
  assert.equal(result.qualification.renditions[1].pixelFormat, "yuv420p");
  assert.equal(result.qualification.renditions[1].width, 1280);
  assert.equal(result.qualification.renditions[1].height, 720);
  assert.equal(result.qualification.renditions[1].durationMs, 2500);
  assert.equal(result.qualification.renditions[1].frameRate, 15);
  assert.equal(result.qualification.renditions[1].audioStreams, 0);
  assert.deepEqual(result.qualification.nonClaims, [
    "browser-playback-success",
    "responsive-layout",
    "reduced-motion-behavior",
    "production-site-deployment",
  ]);
  assert.deepEqual(
    result.qualification.renditions.map((entry) => entry.maximumBytes),
    [1048576, 524288, 524288, 1048576],
  );
});

test("checked-in media evidence binds measured byte budgets", () => {
  const catalog = JSON.parse(fs.readFileSync(
    new URL("../contracts/auditable-demo-media-profiles-v1.json", import.meta.url),
    "utf8",
  ));
  const evidence = JSON.parse(fs.readFileSync(
    new URL("../contracts/evidence/auditable-demo-web-delivery-v1.json", import.meta.url),
    "utf8",
  ));
  const { evidenceRoot, ...body } = evidence;
  assert.equal(evidenceRoot, sha256(Buffer.from(stableJson(body))));
  assert.equal(evidence.qualification.profile.catalogRoot, sha256(Buffer.from(stableJson(catalog))));
  const observed = new Map(evidence.qualification.renditions.map((entry) => [entry.path, entry.bytes]));
  for (const profileId of ["web-delivery-v1", "site-hero-v1"]) {
    for (const rendition of catalog.profiles[profileId].renditions) {
      assert.equal(rendition.budgetBasis.evidence, "contracts/evidence/auditable-demo-web-delivery-v1.json");
      assert.equal(rendition.budgetBasis.observedBytes, observed.get(rendition.budgetBasis.observedPath));
      assert.equal(
        rendition.maximumBytes,
        2 ** Math.ceil(Math.log2(rendition.budgetBasis.observedBytes * rendition.budgetBasis.multiplier)),
      );
    }
  }
});

test("web-delivery qualification rejects false or incomplete media claims", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "input");
  const output = path.join(root, "render");
  writeAdapterOutput(input);
  writeRendererOutput(output, {
    transcript: path.join(input, "complete-transcript.txt"),
    projection: path.join(input, "public-projection.json"),
    scene: path.join(input, "scene.json"),
  });
  const expectedInputs = {
    scene: path.join(output, "scene.json"),
    transcript: path.join(output, "complete-transcript.txt"),
    projection: path.join(output, "public-projection.json"),
  };
  const qualify = (overrides, mediaProfile = "web-delivery-v1") => verifyRendererOutput(
    output,
    RENDERER_IMAGE,
    expectedInputs,
    { mediaProfile, inspectMedia: mediaInspection(overrides) },
  );

  assert.throws(() => qualify({ "demo.mp4": { videoCodec: "vp9" } }), /demo\.mp4 video codec/);
  assert.throws(() => qualify({ "demo.webm": { container: "mp4" } }), /demo\.webm container/);
  assert.throws(() => qualify({ "demo.mp4": { audioStreams: 1 } }), /demo\.mp4 audio/);
  assert.throws(() => qualify({ "demo.mp4": { pixelFormat: "yuv444p" } }), /demo\.mp4 pixel format/);
  assert.throws(() => qualify({ "demo.mp4": { width: 640 } }), /demo\.mp4 dimensions/);
  assert.throws(() => qualify({ "demo.mp4": { durationMs: 4000 } }), /demo\.mp4 duration/);
  assert.throws(() => qualify({ "demo.mp4": { frameRate: 30 } }), /demo\.mp4 frame rate/);
  assert.throws(
    () => qualify({ "demo.mp4": { progressiveDownload: "mdat-before-moov" } }),
    /demo\.mp4 progressive download/,
  );
  assert.throws(() => qualify({}, "site-hero-v1"), /poster\.webp/);
  assert.throws(() => qualify({}, "future-required-v9"), /unsupported media profile/);
});

test("web-delivery qualification rejects budgets, unbound outputs, and duplicate singleton roles", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "input");
  const output = path.join(root, "render");
  writeAdapterOutput(input);
  writeRendererOutput(output, {
    transcript: path.join(input, "complete-transcript.txt"),
    projection: path.join(input, "public-projection.json"),
    scene: path.join(input, "scene.json"),
  });
  const expectedInputs = {
    scene: path.join(output, "scene.json"),
    transcript: path.join(output, "complete-transcript.txt"),
    projection: path.join(output, "public-projection.json"),
  };

  const manifestPath = path.join(output, "manifest.json");
  const mp4Path = path.join(output, "demo.mp4");
  const originalMp4 = fs.readFileSync(mp4Path);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(mp4Path, Buffer.alloc(512 * 1024 + 1));
  manifest.outputs["demo.mp4"] = {
    root: sha256(fs.readFileSync(mp4Path)),
    bytes: fs.statSync(mp4Path).size,
  };
  fs.writeFileSync(manifestPath, stableJson(manifest));
  writeChecksums(output);
  assert.throws(
    () => verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
      mediaProfile: "web-delivery-v1",
      inspectMedia: mediaInspection(),
    }),
    /demo\.mp4 byte budget/,
  );

  fs.writeFileSync(mp4Path, originalMp4);
  manifest.outputs["demo.mp4"] = {
    root: sha256(originalMp4),
    bytes: originalMp4.length,
  };
  fs.writeFileSync(path.join(output, "extra.mp4"), "extra");
  manifest.outputs["extra.mp4"] = { root: sha256(Buffer.from("extra")), bytes: 5 };
  fs.writeFileSync(manifestPath, stableJson(manifest));
  writeChecksums(output);
  assert.throws(
    () => verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
      mediaProfile: "web-delivery-v1",
      inspectMedia: mediaInspection(),
    }),
    /unbound renderer output: extra\.mp4/,
  );

  manifest.webDelivery = {
    schema: "build-images.auditable-demo-web-delivery/v1",
    renditions: [{ path: "extra.mp4", role: "primary-video", mimeType: "video/mp4", maximumBytes: 1024 }],
  };
  fs.writeFileSync(manifestPath, stableJson(manifest));
  writeChecksums(output);
  assert.throws(
    () => verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
      mediaProfile: "web-delivery-v1",
      inspectMedia: mediaInspection(),
    }),
    /maximumBytes is not declared/,
  );

  manifest.webDelivery = {
    schema: "build-images.auditable-demo-web-delivery/v1",
    renditions: [{ path: "extra.mp4", role: "primary-video", mimeType: "video/mp4" }],
  };
  fs.writeFileSync(manifestPath, stableJson(manifest));
  writeChecksums(output);
  const inspectExtra = (filePath) => path.basename(filePath) === "extra.mp4"
    ? mediaInspection()(path.join(path.dirname(filePath), "demo.mp4"))
    : mediaInspection()(filePath);
  assert.throws(
    () => verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
      mediaProfile: "web-delivery-v1",
      inspectMedia: inspectExtra,
    }),
    /duplicate singleton role: primary-video/,
  );
});

test("MP4 fast-start evidence is derived from top-level box order", (t) => {
  const root = temporaryDirectory(t);
  const fast = path.join(root, "fast.mp4");
  const slow = path.join(root, "slow.mp4");
  fs.writeFileSync(fast, Buffer.concat([isoBox("ftyp"), isoBox("moov"), isoBox("mdat", Buffer.from("media"))]));
  fs.writeFileSync(slow, Buffer.concat([isoBox("ftyp"), isoBox("mdat", Buffer.from("media")), isoBox("moov")]));
  assert.equal(inspectIsoBmffFastStart(fast), "moov-before-mdat");
  assert.equal(inspectIsoBmffFastStart(slow), "mdat-before-moov");
});

test("media inspection witness is produced by Buildchain-controlled ffprobe invocation", { skip: process.platform === "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "input");
  const output = path.join(root, "render");
  const tools = path.join(root, "tools");
  const witness = path.join(root, "media-inspection.json");
  writeAdapterOutput(input);
  writeRendererOutput(output, {
    transcript: path.join(input, "complete-transcript.txt"),
    projection: path.join(input, "public-projection.json"),
    scene: path.join(input, "scene.json"),
  });
  fs.mkdirSync(tools);
  const ffprobe = path.join(tools, "ffprobe");
  fs.writeFileSync(ffprobe, `#!/usr/bin/env node
const name = process.argv.at(-1).split("/").at(-1);
const facts = {
  "demo.mp4": ["mov,mp4,m4a,3gp,3g2,mj2", "h264", "yuv420p", "15/1", "2.5"],
  "demo.webm": ["matroska,webm", "vp9", "yuv420p", "15/1", "2.5"],
  "demo.gif": ["gif", "gif", "bgra", "12/1", "2.5"],
  "poster.png": ["image2", "png", "rgba", "0/0", "0"],
}[name];
process.stdout.write(JSON.stringify({
  format: { format_name: facts[0], duration: facts[4] },
  streams: [{ codec_type: "video", codec_name: facts[1], pix_fmt: facts[2], width: 1280, height: 720, avg_frame_rate: facts[3] }],
}));
`);
  fs.chmodSync(ffprobe, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tools}:${originalPath}`;
  try {
    inspectRendererMedia({
      "--render-output": output,
      "--renderer-image": RENDERER_IMAGE,
      "--output": witness,
    });
  } finally {
    process.env.PATH = originalPath;
  }
  const observed = JSON.parse(fs.readFileSync(witness, "utf8"));
  assert.equal(observed.schema, "buildchain.auditable-demo-media-inspection/v1");
  assert.match(observed.inspectionRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(observed.members.find((entry) => entry.path === "demo.mp4").facts.progressiveDownload, "moov-before-mdat");
  assert.equal(observed.members.find((entry) => entry.path === "demo.webm").facts.videoCodec, "vp9");

  const evidence = path.join(root, "fixture-evidence.json");
  qualifyMediaFixture({
    "--render-output": output,
    "--media-inspection": witness,
    "--media-profile": "web-delivery-v1",
    "--renderer-image": RENDERER_IMAGE,
    "--renderer-source-repository": "kungfu-systems/build-images",
    "--renderer-source-ref": "refs/tags/v1.3.0-alpha.16",
    "--renderer-source-sha": SOURCE_SHA,
    "--output": evidence,
  });
  const measured = JSON.parse(fs.readFileSync(evidence, "utf8"));
  assert.equal(measured.schema, "buildchain.auditable-demo-media-profile-fixture/v1");
  assert.equal(measured.renderer.sourceSha, SOURCE_SHA);
  assert.equal(measured.qualification.profile.id, "web-delivery-v1");
  assert.match(measured.evidenceRoot, /^sha256:[0-9a-f]{64}$/);

  observed.members[0].facts.untrustedClaim = true;
  const inspectionBody = {
    schema: observed.schema,
    rendererImage: observed.rendererImage,
    members: observed.members,
  };
  observed.inspectionRoot = sha256(Buffer.from(stableJson(inspectionBody)));
  fs.writeFileSync(witness, stableJson(observed));
  assert.throws(
    () => qualifyMediaFixture({
      "--render-output": output,
      "--media-inspection": witness,
      "--media-profile": "web-delivery-v1",
      "--renderer-image": RENDERER_IMAGE,
      "--renderer-source-repository": "kungfu-systems/build-images",
      "--renderer-source-ref": "refs/tags/v1.3.0-alpha.16",
      "--renderer-source-sha": SOURCE_SHA,
      "--output": path.join(root, "invalid-evidence.json"),
    }),
    /untrustedClaim is not declared/,
  );
});
