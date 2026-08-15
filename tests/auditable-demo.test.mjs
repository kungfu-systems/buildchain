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
  renditionInputRoots,
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
import {
  MAX_LONG_FORM_RENDERER_MANIFEST_BYTES,
  readRendererManifest,
  validateRendererComposition,
} from "../scripts/auditable-demo-renditions.mjs";

const RENDERER_IMAGE = `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${"a".repeat(64)}`;
const SOURCE_SHA = "b".repeat(40);

const COMPOSITION_HELPERS = {
  exactKeys(value, required, optional, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const allowed = new Set([...required, ...optional]);
    for (const key of required) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
    }
  },
  invariant(condition, message) {
    if (!condition) throw new Error(message);
  },
};

function terminalFillEvidence(width, height, columns, rows) {
  return {
    mode: "terminal-fill",
    contentViewport: { x: 0, y: 0, width, height, fillRatio: 1 },
    terminalGeometry: {
      columns,
      rows,
      cellWidth: Number((width / columns).toFixed(6)),
      cellHeight: Number((height / rows).toFixed(6)),
      fontSize: Number((Math.min((width / columns) * 1.6, (height / rows) * 0.8)).toFixed(6)),
      lineHeight: Number((height / rows).toFixed(6)),
      layout: "exact-grid",
    },
  };
}

function terminalFillManifest() {
  const primary = terminalFillEvidence(1920, 1080, 150, 36);
  const responsive = terminalFillEvidence(1280, 720, 150, 28);
  return {
    renderer: { contractVersion: "1.4.0" },
    policy: { compositionMode: "terminal-fill" },
    derivation: {
      sourceFrames: { width: 1920, height: 1080, composition: structuredClone(primary) },
      sourceFrameSets: [
        { id: "1080p", role: "primary", width: 1920, height: 1080, composition: primary },
        { id: "720p", role: "responsive", width: 1280, height: 720, composition: responsive },
      ],
    },
  };
}

const TERMINAL_FILL_RENDITIONS = [
  { id: "1080p", role: "primary", width: 1920, height: 1080, columns: 150, rows: 36, compositionMode: "terminal-fill" },
  { id: "720p", role: "responsive", width: 1280, height: 720, columns: 150, rows: 28, compositionMode: "terminal-fill" },
];

test("renderer composition admission proves exact terminal-fill viewports and fails closed on drift", () => {
  const admitted = validateRendererComposition(
    terminalFillManifest(),
    TERMINAL_FILL_RENDITIONS,
    COMPOSITION_HELPERS,
  );
  assert.equal(admitted.mode, "terminal-fill");

  const missing = terminalFillManifest();
  delete missing.derivation.sourceFrameSets[0].composition.contentViewport;
  assert.throws(
    () => validateRendererComposition(missing, TERMINAL_FILL_RENDITIONS, COMPOSITION_HELPERS),
    /contentViewport is required/u,
  );

  const outOfBounds = terminalFillManifest();
  outOfBounds.derivation.sourceFrameSets[1].composition.contentViewport.x = 1;
  assert.throws(
    () => validateRendererComposition(outOfBounds, TERMINAL_FILL_RENDITIONS, COMPOSITION_HELPERS),
    /out of bounds/u,
  );

  const nonFull = terminalFillManifest();
  nonFull.derivation.sourceFrameSets[1].composition.contentViewport.width = 1279;
  nonFull.derivation.sourceFrameSets[1].composition.contentViewport.fillRatio = Number((1279 / 1280).toFixed(6));
  assert.throws(
    () => validateRendererComposition(nonFull, TERMINAL_FILL_RENDITIONS, COMPOSITION_HELPERS),
    /full-frame terminal viewport/u,
  );

  const renditionMismatch = terminalFillManifest();
  renditionMismatch.derivation.sourceFrameSets[0].composition.terminalGeometry.columns = 149;
  assert.throws(
    () => validateRendererComposition(renditionMismatch, TERMINAL_FILL_RENDITIONS, COMPOSITION_HELPERS),
    /rendition-mismatched/u,
  );

  const manifestDrift = terminalFillManifest();
  manifestDrift.derivation.sourceFrames.composition.contentViewport.width = 1919;
  assert.throws(
    () => validateRendererComposition(manifestDrift, TERMINAL_FILL_RENDITIONS, COMPOSITION_HELPERS),
    /drifted between sourceFrames and sourceFrameSets/u,
  );

  const legacyFramed = validateRendererComposition(
    {
      renderer: { contractVersion: "1.3.1" },
      policy: {},
      derivation: {
        sourceFrames: { width: 1920, height: 1080 },
        sourceFrameSets: [
          { id: "1080p", role: "primary", width: 1920, height: 1080 },
          { id: "720p", role: "responsive", width: 1280, height: 720 },
        ],
      },
    },
    TERMINAL_FILL_RENDITIONS.map(({ compositionMode: _compositionMode, ...entry }) => entry),
    COMPOSITION_HELPERS,
  );
  assert.deepEqual(legacyFramed, {
    mode: "presentation-framed",
    frameSets: [],
    evidence: "legacy-presentation-default",
  });
  assert.throws(
    () => validateRendererComposition(
      { renderer: { contractVersion: "1.3.1" }, policy: {}, derivation: {} },
      TERMINAL_FILL_RENDITIONS,
      COMPOSITION_HELPERS,
    ),
    /does not support composition evidence/u,
  );
});

function longFormRendererRenditions() {
  return [
    { id: "1080p", role: "primary", width: 1920, height: 1080 },
    { id: "720p", role: "responsive", width: 1280, height: 720 },
  ].map((entry) => ({
    id: entry.id,
    role: entry.role,
    scene: {
      path: {
        durationClass: "long-form",
        durationMs: 120000,
        fps: 10,
        width: entry.width,
        height: entry.height,
      },
    },
    terminalCapture: {
      schema: "kungfu.terminal-capture/v1",
      root: `sha256:${(entry.id === "1080p" ? "c" : "d").repeat(64)}`,
      durationMs: 119000,
      events: 1000,
      bytes: 1024 * 1024,
      path: { normalizedReplay: "x".repeat(17 * 1024 * 1024) },
    },
  }));
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-auditable-demo-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("oversized renderer manifests remain limited to bounded long-form native renditions", (t) => {
  const root = temporaryDirectory(t);
  const manifestPath = path.join(root, "manifest.json");
  const manifest = {
    schema: "build-images.auditable-demo-render/v1",
    renderer: { image: RENDERER_IMAGE },
    inputs: { renditions: longFormRendererRenditions() },
    outputs: {},
  };
  fs.writeFileSync(manifestPath, stableJson(manifest));
  assert.ok(fs.statSync(manifestPath).size > 32 * 1024 * 1024);
  assert.ok(fs.statSync(manifestPath).size < MAX_LONG_FORM_RENDERER_MANIFEST_BYTES);
  const helpers = {
    decodeUtf8: (bytes) => bytes.toString("utf8"),
    digestPattern: /^sha256:[0-9a-f]{64}$/,
    invariant: (condition, message) => { if (!condition) throw new Error(message); },
    maxBytes: 4 * 1024 * 1024,
    maxEvents: 10_000,
    readRegular: (file, label, maximum) => {
      const metadata = fs.statSync(file);
      assert.ok(metadata.size <= maximum, `${label} exceeds ${maximum} bytes`);
      return fs.readFileSync(file);
    },
  };
  assert.equal(readRendererManifest(manifestPath, helpers).manifest.inputs.renditions.length, 2);
  writeChecksums(root);
  assert.throws(() => verifyChecksums(root), /manifest\.json exceeds 8388608 bytes/);
  verifyChecksums(root, "checksums.sha256", { allowLongFormRendererManifest: true });

  manifest.inputs.renditions[1].terminalCapture.events = 10_001;
  fs.writeFileSync(manifestPath, stableJson(manifest));
  assert.throws(
    () => readRendererManifest(manifestPath, helpers),
    /rendition 1 is not bounded long-form evidence/,
  );

  fs.truncateSync(manifestPath, MAX_LONG_FORM_RENDERER_MANIFEST_BYTES + 1);
  assert.throws(
    () => readRendererManifest(manifestPath, helpers),
    /renderer manifest exceeds 67108864 bytes/,
  );
});

function terminalCapture(
  durationMs = 2500,
  completionSchema = "kungfu.agent-work-lab.tui-autoplay/v1",
) {
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
      schema: completionSchema,
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
  const terminalDimensions = inputs.terminalCapture
    ? JSON.parse(fs.readFileSync(inputs.terminalCapture, "utf8")).dimensions
    : null;
  const contentViewport = {
    x: 24,
    y: 72,
    width: scene.width - 48,
    height: scene.height - 96,
  };
  contentViewport.fillRatio = Number((
    (contentViewport.width * contentViewport.height) / (scene.width * scene.height)
  ).toFixed(6));
  const composition = {
    mode: scene.compositionMode ?? "presentation-framed",
    contentViewport,
    terminalGeometry: terminalDimensions
      ? {
        columns: terminalDimensions.columns,
        rows: terminalDimensions.rows,
        cellWidth: 7.82,
        cellHeight: 13.78,
        fontSize: 13,
        lineHeight: 13.78,
        layout: "presentation-flow",
      }
      : null,
  };
  fs.writeFileSync(path.join(directory, "complete-transcript.txt"), transcript);
  fs.writeFileSync(path.join(directory, "public-projection.json"), stableJson(projection));
  fs.writeFileSync(path.join(directory, "scene.json"), stableJson(scene));
  const mediaNames = [
    "demo.gif",
    "demo.mp4",
    "demo.webm",
    ...(inputs.responsive ? ["demo-720p.mp4", "demo-720p.webm"] : []),
    "poster.png",
  ];
  for (const name of mediaNames) {
    const bytes = name.endsWith(".mp4")
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
    [...mediaNames, "media-probe.json"].map((name) => [
      name,
      {
        root: sha256(fs.readFileSync(path.join(directory, name))),
        bytes: fs.statSync(path.join(directory, name)).size,
      },
    ]),
  );
  fs.writeFileSync(path.join(directory, "manifest.json"), stableJson({
    schema: "build-images.auditable-demo-render/v1",
    renderer: { contractVersion: "1.4.0", image: RENDERER_IMAGE },
    policy: { compositionMode: composition.mode },
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
    derivation: {
      sourceFrames: {
        width: scene.width,
        height: scene.height,
        composition,
      },
    },
    outputs,
  }));
  writeChecksums(directory);
}

function mediaInspection(overrides = {}, options = {}) {
  const sourceWidth = options.sourceWidth || 1280;
  const sourceHeight = options.sourceHeight || 720;
  const durationMs = options.durationMs || 2500;
  const frameRate = options.frameRate || 15;
  const base = {
    "demo.mp4": {
      container: "mp4",
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      width: sourceWidth,
      height: sourceHeight,
      durationMs,
      frameRate,
      audioStreams: 0,
      progressiveDownload: "moov-before-mdat",
    },
    "demo.webm": {
      container: "webm",
      videoCodec: "vp9",
      pixelFormat: "yuv420p",
      width: sourceWidth,
      height: sourceHeight,
      durationMs,
      frameRate,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
    "demo.gif": {
      container: "gif",
      videoCodec: "gif",
      pixelFormat: "bgra",
      width: 1280,
      height: 720,
      durationMs,
      frameRate: 12,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
    "poster.png": {
      container: "png",
      videoCodec: "png",
      pixelFormat: "rgba",
      width: sourceWidth,
      height: sourceHeight,
      durationMs: 0,
      frameRate: 0,
      audioStreams: 0,
      progressiveDownload: "not-applicable",
    },
    ...(options.responsive
      ? {
        "demo-720p.mp4": {
          container: "mp4",
          videoCodec: "h264",
          pixelFormat: "yuv420p",
          width: 1280,
          height: 720,
          durationMs,
          frameRate,
          audioStreams: 0,
          progressiveDownload: "moov-before-mdat",
        },
        "demo-720p.webm": {
          container: "webm",
          videoCodec: "vp9",
          pixelFormat: "yuv420p",
          width: 1280,
          height: 720,
          durationMs,
          frameRate,
          audioStreams: 0,
          progressiveDownload: "not-applicable",
        },
      }
      : {}),
  };
  const facts = Object.fromEntries(
    Object.entries(base).map(([name, value]) => [name, { ...value, ...(overrides[name] || {}) }]),
  );
  return (filePath) => facts[path.basename(filePath)];
}

function writeMediaInspectionWitness(filePath, renderOutput, overrides = {}) {
  const scene = JSON.parse(fs.readFileSync(path.join(renderOutput, "scene.json"), "utf8"));
  const responsive = fs.existsSync(path.join(renderOutput, "demo-720p.mp4"));
  const inspect = mediaInspection(overrides, {
    responsive,
    sourceWidth: scene.width,
    sourceHeight: scene.height,
    durationMs: scene.durationMs,
    frameRate: scene.fps,
  });
  const members = [
    "demo.gif",
    "demo.mp4",
    "demo.webm",
    ...(responsive ? ["demo-720p.mp4", "demo-720p.webm"] : []),
    "poster.png",
  ].map((name) => {
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

test("adapter output requires an explicit bounded long-form scene", (t) => {
  const root = temporaryDirectory(t);
  writeAdapterOutput(root, 61_000, true);
  assert.throws(() => validateAdapterOutput(root), /scene\.durationMs is out of range/u);

  const scenePath = path.join(root, "scene.json");
  const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
  fs.writeFileSync(scenePath, stableJson({ ...scene, durationClass: "long-form", fps: 10 }));
  const validated = validateAdapterOutput(root);
  assert.equal(validated.scene.durationClass, "long-form");
  assert.equal(validated.terminalCapture.durationMs, 60_500);

  fs.writeFileSync(scenePath, stableJson({ ...scene, durationClass: "long-form", durationMs: 360_001, fps: 1 }));
  assert.throws(() => validateAdapterOutput(root), /scene\.durationMs is out of range/u);
  fs.writeFileSync(scenePath, stableJson({ ...scene, durationClass: "long-form", fps: 11 }));
  assert.throws(() => validateAdapterOutput(root), /scene\.fps is out of range/u);

  const extended = path.join(root, "extended");
  writeAdapterOutput(extended, 228_751, true);
  const extendedScenePath = path.join(extended, "scene.json");
  const extendedScene = JSON.parse(fs.readFileSync(extendedScenePath, "utf8"));
  fs.writeFileSync(extendedScenePath, stableJson({ ...extendedScene, durationClass: "long-form", fps: 7 }));
  assert.equal(validateAdapterOutput(extended).scene.durationMs, 228_751);
  fs.writeFileSync(extendedScenePath, stableJson({ ...extendedScene, durationClass: "long-form", fps: 8 }));
  assert.throws(() => validateAdapterOutput(extended), /deterministic source-frame bound/u);
});

test("optional terminal capture is bounded and grants no implicit authority", (t) => {
  const root = temporaryDirectory(t);
  writeAdapterOutput(root, 2500, true);
  assert.equal(validateAdapterOutput(root).terminalCapture.schema, "kungfu.terminal-capture/v1");

  const capturePath = path.join(root, "terminal-capture.json");
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  capture.completion.schema = "kungfu.kfd-agent-hub-qualification/v1";
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.equal(
    validateAdapterOutput(root).terminalCapture.completion.schema,
    "kungfu.kfd-agent-hub-qualification/v1",
  );

  capture.completion.status = "passed";
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /not a qualified versioned result/);

  capture.completion.status = "qualified";
  capture.completion.schema = "unversioned-completion";
  fs.writeFileSync(capturePath, stableJson(capture));
  assert.throws(() => validateAdapterOutput(root), /not a qualified versioned result/);

  capture.completion.schema = "kungfu.kfd-agent-hub-qualification/v1";
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

test("native rendition set binds distinct 1080p and 720p captures", (t) => {
  const root = temporaryDirectory(t);
  writeAdapterOutput(root, 2500, true);
  const primaryScenePath = path.join(root, "scene.json");
  const primaryScene = JSON.parse(fs.readFileSync(primaryScenePath, "utf8"));
  primaryScene.width = 1920;
  primaryScene.height = 1080;
  fs.writeFileSync(primaryScenePath, stableJson(primaryScene));

  fs.writeFileSync(path.join(root, "complete-transcript-720p.txt"), "compact layout\nartifact qualified\n");
  fs.writeFileSync(path.join(root, "scene-720p.json"), stableJson({
    ...primaryScene,
    id: "qualification-720p",
    width: 1280,
    height: 720,
  }));
  fs.writeFileSync(path.join(root, "public-projection-720p.json"), stableJson({
    schema: "build-images.demo-projection/v1",
    evidenceClass: "qualified-build-output",
    claimBoundary: "Presentation is traceable to the retained transcript and is not a screen capture.",
    cues: [{ startMs: 0, endMs: 2500, transcriptLines: [1, 2], annotation: "compact output" }],
  }));
  const responsiveCapture = terminalCapture(2500);
  responsiveCapture.dimensions = { columns: 150, rows: 28 };
  responsiveCapture.events[0].data = Buffer.from("compact 150x28\r\n").toString("base64");
  responsiveCapture.completion.reportRoot = `sha256:${"f".repeat(64)}`;
  fs.writeFileSync(path.join(root, "terminal-capture-720p.json"), stableJson(responsiveCapture));

  const primaryCaptureRoot = sha256(fs.readFileSync(path.join(root, "terminal-capture.json")));
  const responsiveCaptureRoot = sha256(fs.readFileSync(path.join(root, "terminal-capture-720p.json")));
  const renditionSetPath = path.join(root, "rendition-set.json");
  fs.writeFileSync(renditionSetPath, stableJson({
    schema: "kungfu.auditable-demo.rendition-set/v1",
    renditions: [
      {
        id: "1080p", role: "primary", transcript: "complete-transcript.txt",
        projection: "public-projection.json", scene: "scene.json",
        terminalCapture: "terminal-capture.json", captureRoot: primaryCaptureRoot,
      },
      {
        id: "720p", role: "responsive", transcript: "complete-transcript-720p.txt",
        projection: "public-projection-720p.json", scene: "scene-720p.json",
        terminalCapture: "terminal-capture-720p.json", captureRoot: responsiveCaptureRoot,
      },
    ],
    authority: {
      classification: "capture-routing-metadata",
      grants: [],
      nonAuthorities: [
        "publication-authority",
        "runtime-authority",
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
  }));

  const normalized = validateAdapterOutput(root);
  assert.equal(normalized.renditionSet.renditions[0].scene.width, 1920);
  assert.equal(normalized.renditionSet.renditions[1].scene.width, 1280);
  assert.deepEqual(normalized.renditionSet.renditions.map(({ files }) => files.scene), ["scene.json", "scene-720p.json"]);
  for (const rendition of normalized.renditionSet.renditions) {
    ["scene", "transcript", "projection"].forEach((member) => assert.doesNotThrow(() => fs.readFileSync(path.join(root, rendition.files[member]))));
  }
  const inputRoots = renditionInputRoots(root, normalized.renditionSet.renditions);
  assert.equal(stableJson(inputRoots), stableJson(JSON.parse(stableJson(inputRoots))));
  assert.notEqual(
    normalized.renditionSet.renditions[0].captureRoot,
    normalized.renditionSet.renditions[1].captureRoot,
  );

  const renditionSet = JSON.parse(fs.readFileSync(renditionSetPath, "utf8"));
  renditionSet.renditions[1].captureRoot = primaryCaptureRoot;
  fs.writeFileSync(renditionSetPath, stableJson(renditionSet));
  assert.throws(() => validateAdapterOutput(root), /captureRoot mismatch|capture roots must be distinct/u);
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
  const webGate = path.join(root, "web-gate");
  const smokeInspectionPath = path.join(root, "smoke-inspection.json");
  const mediaInspectionPath = path.join(root, "media-inspection.json");
  writeMediaInspectionWitness(smokeInspectionPath, smokeOutput);
  finalizeGate({
    "--adapter-output": adapter,
    "--smoke-input": smokeInput,
    "--smoke-output": smokeOutput,
    "--source-coordinate": sourceCoordinate,
    "--diagnostics": diagnostics,
    "--adapter": "scripts/demo-adapter",
    "--renderer-image": RENDERER_IMAGE,
    "--source-sha": SOURCE_SHA,
    "--media-profile": "web-delivery-v1",
    "--media-inspection": smokeInspectionPath,
    "--output": webGate,
  });
  const webGateRoot = verifyChecksums(webGate);
  writeMediaInspectionWitness(mediaInspectionPath, fullOutput);
  finalizeMedia({
    "--gate-bundle": webGate,
    "--gate-root": webGateRoot,
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
  assert.equal(webMediaReceipt.qualifiedGateRoot, webGateRoot);
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

test("responsive qualification binds one source scene to exact 1080p and 720p renditions", (t) => {
  const root = temporaryDirectory(t);
  const input = path.join(root, "input");
  const output = path.join(root, "render");
  writeAdapterOutput(input);
  const inputScenePath = path.join(input, "scene.json");
  const sourceScene = JSON.parse(fs.readFileSync(inputScenePath, "utf8"));
  fs.writeFileSync(inputScenePath, stableJson({
    ...sourceScene,
    width: 1920,
    height: 1080,
  }));
  writeRendererOutput(output, {
    transcript: path.join(input, "complete-transcript.txt"),
    projection: path.join(input, "public-projection.json"),
    scene: inputScenePath,
    responsive: true,
  });
  const expectedInputs = {
    scene: path.join(output, "scene.json"),
    transcript: path.join(output, "complete-transcript.txt"),
    projection: path.join(output, "public-projection.json"),
  };
  const inspect = mediaInspection({}, {
    responsive: true,
    sourceWidth: 1920,
    sourceHeight: 1080,
  });
  const result = verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
    mediaProfile: "responsive-web-delivery-v1",
    inspectMedia: inspect,
  });

  assert.equal(result.qualification.profile.id, "responsive-web-delivery-v1");
  assert.deepEqual(
    result.qualification.renditions.map((entry) => entry.role),
    [
      "readme-compatibility",
      "primary-video",
      "alternate-video",
      "evidence-poster",
      "responsive-primary-video",
      "responsive-alternate-video",
    ],
  );
  const byRole = new Map(
    result.qualification.renditions.map((entry) => [entry.role, entry]),
  );
  assert.deepEqual(
    [byRole.get("primary-video").width, byRole.get("primary-video").height],
    [1920, 1080],
  );
  assert.equal(byRole.get("primary-video").dimensionPolicy, "scene-exact");
  assert.deepEqual(
    [
      byRole.get("responsive-primary-video").width,
      byRole.get("responsive-primary-video").height,
    ],
    [1280, 720],
  );
  assert.equal(
    byRole.get("responsive-primary-video").dimensionPolicy,
    "exact-downscale-same-aspect",
  );
  assert.deepEqual(
    [
      byRole.get("readme-compatibility").width,
      byRole.get("readme-compatibility").height,
    ],
    [1280, 720],
  );

  assert.throws(
    () => verifyRendererOutput(output, RENDERER_IMAGE, expectedInputs, {
      mediaProfile: "responsive-web-delivery-v1",
      inspectMedia: mediaInspection(
        { "demo-720p.mp4": { width: 1920, height: 1080 } },
        { responsive: true, sourceWidth: 1920, sourceHeight: 1080 },
      ),
    }),
    /demo-720p\.mp4 dimensions mismatch/,
  );
});

test("responsive qualification rejects implicit upscales and aspect-ratio drift", (t) => {
  const root = temporaryDirectory(t);
  const qualifyScene = (width, height) => {
    const input = path.join(root, `input-${width}-${height}`);
    const output = path.join(root, `render-${width}-${height}`);
    writeAdapterOutput(input);
    const scenePath = path.join(input, "scene.json");
    const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    fs.writeFileSync(scenePath, stableJson({ ...scene, width, height }));
    writeRendererOutput(output, {
      transcript: path.join(input, "complete-transcript.txt"),
      projection: path.join(input, "public-projection.json"),
      scene: scenePath,
      responsive: true,
    });
    return () => verifyRendererOutput(output, RENDERER_IMAGE, {
      scene: path.join(output, "scene.json"),
      transcript: path.join(output, "complete-transcript.txt"),
      projection: path.join(output, "public-projection.json"),
    }, {
      mediaProfile: "responsive-web-delivery-v1",
      inspectMedia: mediaInspection({}, {
        responsive: true,
        sourceWidth: width,
        sourceHeight: height,
      }),
    });
  };

  assert.throws(qualifyScene(640, 360), /dimensions would upscale the scene/);
  assert.throws(qualifyScene(1920, 1000), /dimensions drift from the scene aspect ratio/);
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
  for (const profileId of [
    "web-delivery-v1",
    "responsive-web-delivery-v1",
    "responsive-long-form-web-delivery-v1",
    "site-hero-v1",
  ]) {
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

test("checked-in responsive evidence binds one exact 1080p and 720p renderer cut", () => {
  const evidence = JSON.parse(fs.readFileSync(
    new URL(
      "../contracts/evidence/auditable-demo-responsive-web-delivery-v1.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const { evidenceRoot, ...body } = evidence;
  assert.equal(evidenceRoot, sha256(Buffer.from(stableJson(body))));
  assert.equal(
    evidence.renderer.image,
    "ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:b70a2f5631665f685280bc9d7434c5ed5cf48b760b728873734d0c47bff72b25",
  );
  assert.equal(evidence.renderer.sourceRef, "refs/tags/v1.3.0-alpha.20");
  assert.equal(
    evidence.renderer.sourceSha,
    "b3cebc2deb5f140af74db24b1b45233ac6733ef1",
  );
  const roles = new Map(
    evidence.qualification.renditions.map((entry) => [entry.role, entry]),
  );
  for (const role of ["primary-video", "alternate-video", "evidence-poster"]) {
    assert.equal(roles.get(role).width, 1920);
    assert.equal(roles.get(role).height, 1080);
    assert.equal(roles.get(role).dimensionPolicy, "scene-exact");
  }
  for (const role of [
    "responsive-primary-video",
    "responsive-alternate-video",
    "readme-compatibility",
  ]) {
    assert.equal(roles.get(role).width, 1280);
    assert.equal(roles.get(role).height, 720);
    assert.equal(
      roles.get(role).dimensionPolicy,
      "exact-downscale-same-aspect",
    );
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
