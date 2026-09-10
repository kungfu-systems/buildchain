import fs from "node:fs";
import path from "node:path";
import {
  DIGEST,
  NON_AUTHORITIES,
  RENDITIONS,
  PRESENTATION_FRAMED,
  durationPolicy,
  requireValue,
  stableJson,
  rootJson,
  regular,
  readJson,
  inside,
  exactKeys,
} from "./values.js";
import { validateScenario } from "./scenario.js";
function validateCapture(
  capture,
  rendition,
  summaryRoot,
  durationClass,
  declaredPlayback,
) {
  const policy = durationPolicy(durationClass);
  requireValue(
    capture.schema === "buildchain.declarative-terminal-capture/v1",
    "capture schema mismatch",
  );
  requireValue(
    JSON.stringify(capture.dimensions) ===
      JSON.stringify({ columns: rendition.columns, rows: rendition.rows }),
    "capture dimensions mismatch",
  );
  requireValue(
    capture.completion?.status === "qualified" &&
      capture.completion?.reportRoot === summaryRoot,
    "capture completion mismatch",
  );
  requireValue(
    capture.exitCode === 0 &&
      capture.authority?.classification === "volatile-terminal-observation",
    "capture authority or exit mismatch",
  );
  requireValue(
    JSON.stringify(capture.authority) ===
      JSON.stringify({
        classification: "volatile-terminal-observation",
        grants: [],
        nonAuthorities: NON_AUTHORITIES,
      }),
    "capture grants authority",
  );
  requireValue(
    Array.isArray(capture.events) &&
      capture.events.length === capture.completion.eventCount &&
      capture.events.length > 0,
    "capture events mismatch",
  );
  requireValue(
    Number.isInteger(capture.durationMs) &&
      capture.durationMs >= 500 &&
      capture.durationMs <= policy.maximumSeconds * 1000,
    "capture duration exceeds its declared class",
  );
  let previousAtMs = -1;
  for (const [index, event] of capture.events.entries()) {
    requireValue(
      Number.isInteger(event.atMs) &&
        event.atMs >= 0 &&
        event.atMs < capture.durationMs &&
        event.atMs >= previousAtMs,
      "capture event timeline is invalid",
    );
    requireValue(
      index > 0 || event.atMs === 0,
      "capture event timeline must start at zero",
    );
    previousAtMs = event.atMs;
  }
  if (!declaredPlayback) {
    requireValue(
      capture.playback === undefined,
      "legacy capture unexpectedly declares playback evidence",
    );
    return capture;
  }
  exactKeys(
    capture.playback,
    [
      "schema",
      "mode",
      "timingSource",
      "activeDurationMs",
      "finalHoldMs",
      "presentedDurationMs",
      "observedLastEventMs",
      "eventPayloadRoot",
      "eventOrder",
    ],
    [],
    "capture.playback",
  );
  requireValue(
    capture.playback.schema === "buildchain.declarative-terminal-playback/v1",
    "capture playback schema mismatch",
  );
  requireValue(
    capture.playback.mode === declaredPlayback.mode,
    "capture playback mode mismatch",
  );
  requireValue(
    capture.playback.timingSource === "declared-event-ordinal",
    "capture playback timing source mismatch",
  );
  requireValue(
    capture.playback.activeDurationMs === declaredPlayback.activeDurationMs &&
      capture.playback.finalHoldMs === declaredPlayback.finalHoldMs,
    "capture playback duration mismatch",
  );
  requireValue(
    capture.playback.presentedDurationMs === capture.durationMs &&
      capture.durationMs ===
        declaredPlayback.activeDurationMs + declaredPlayback.finalHoldMs,
    "capture presented duration mismatch",
  );
  requireValue(
    Number.isInteger(capture.playback.observedLastEventMs) &&
      capture.playback.observedLastEventMs >= 0,
    "capture observed duration is invalid",
  );
  requireValue(
    capture.playback.eventOrder === "preserved",
    "capture playback event order mismatch",
  );
  requireValue(
    capture.playback.eventPayloadRoot ===
      rootJson(capture.events.map((event) => event.data)),
    "capture playback payload root mismatch",
  );
  const lastIndex = capture.events.length - 1;
  for (const [index, event] of capture.events.entries()) {
    const expectedAtMs =
      lastIndex === 0
        ? 0
        : Math.round((index * declaredPlayback.activeDurationMs) / lastIndex);
    requireValue(
      event.atMs === expectedAtMs,
      "capture playback timeline is not deterministic",
    );
  }
  return capture;
}

function projection(
  capture,
  transcript,
  demo,
  rendition,
  durationClass,
  sharedCaptureDurationMs,
  compositionMode,
) {
  const lines = transcript.endsWith("\n")
    ? transcript.slice(0, -1).split("\n")
    : transcript.split("\n");
  const policy = durationPolicy(durationClass);
  const durationMs = capture.playback
    ? sharedCaptureDurationMs
    : Math.min(policy.maximumSeconds * 1000, sharedCaptureDurationMs + 1000);
  const projected = {
    schema: "kungfu.terminal-capture/v1",
    command: capture.command,
    dimensions: capture.dimensions,
    durationMs: sharedCaptureDurationMs,
    encoding: capture.encoding,
    events: capture.events,
    completion: capture.completion,
    exitCode: capture.exitCode,
    authority: capture.authority,
  };
  const scene = {
    schema: "build-images.demo-scene/v1",
    id: `${demo.id}-${rendition.id}`.slice(0, 64),
    width: rendition.width,
    height: rendition.height,
    fps: policy.durationClass === "long-form" ? 10 : 15,
    ...(policy.durationClass === "long-form"
      ? { durationClass: "long-form" }
      : {}),
    compositionMode,
    durationMs,
    title: demo.title,
    commandLabel: capture.command,
    background: "#0B1020",
    accent: "#67E8A5",
  };
  const publicProjection = {
    schema: "build-images.demo-projection/v1",
    evidenceClass: "exact-standalone-binary-declarative-demo/v1",
    claimBoundary: demo.claimBoundary,
    cues: [
      {
        startMs: 0,
        endMs: durationMs,
        transcriptLines: lines.slice(0, 80).map((_, index) => index + 1),
        annotation: "declared exact-binary scenario",
      },
    ],
  };
  return { projected, scene, publicProjection };
}

function prepareOutput(output) {
  if (!fs.existsSync(output)) return fs.mkdirSync(output, { recursive: true });
  const metadata = fs.lstatSync(output);
  requireValue(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      fs.readdirSync(output).length === 0,
    "output must be an empty directory",
  );
}

export function adaptCapture({ artifactRoot, output }) {
  const root = path.resolve(artifactRoot);
  const manifest = readJson(
    path.join(root, "manifest.json"),
    "capture manifest",
  );
  requireValue(
    manifest.schema === "buildchain.declarative-demo-capture/v1" &&
      manifest.status === "qualified",
    "capture manifest is not qualified",
  );
  const declaredRoot = manifest.root;
  const { root: _root, ...manifestBody } = manifest;
  requireValue(
    DIGEST.test(declaredRoot) && rootJson(manifestBody) === declaredRoot,
    "capture manifest root mismatch",
  );
  requireValue(
    manifest.authority?.grants?.length === 0 &&
      JSON.stringify(manifest.authority?.nonAuthorities) ===
        JSON.stringify(NON_AUTHORITIES),
    "capture manifest grants authority",
  );
  const scenario = validateScenario(
    readJson(path.join(root, "scenario.json"), "captured scenario"),
  );
  requireValue(
    rootJson(scenario) === manifest.scenarioRoot,
    "captured scenario root mismatch",
  );
  requireValue(
    Array.isArray(manifest.renditions) && manifest.renditions.length === 2,
    "capture rendition set is invalid",
  );
  const executionPolicy = durationPolicy(manifest.execution?.durationClass);
  requireValue(
    stableJson(manifest.execution?.playback) === stableJson(scenario.playback),
    "capture manifest playback declaration mismatch",
  );
  prepareOutput(output);
  const set = [];
  const loaded = RENDITIONS.map((expected, index) => {
    const descriptor = manifest.renditions[index];
    requireValue(
      descriptor.id === expected.id &&
        descriptor.role === expected.role &&
        descriptor.width === expected.width &&
        descriptor.height === expected.height,
      `capture rendition ${index} mismatch`,
    );
    const transcriptBytes = regular(
      inside(root, descriptor.transcript, "capture transcript"),
      "capture transcript",
      4 * 1024 * 1024,
    );
    const transcript = transcriptBytes.toString("utf8").replace(/\r\n/gu, "\n");
    requireValue(transcript.trim().length > 0, "capture transcript is empty");
    const summary = readJson(
      inside(root, descriptor.runSummary, "run summary"),
      "run summary",
    );
    requireValue(
      rootJson(summary) === descriptor.runSummaryRoot,
      "run summary root mismatch",
    );
    const captureBytes = regular(
      inside(root, descriptor.terminalCapture, "terminal capture"),
      "terminal capture",
      4 * 1024 * 1024,
    );
    const capture = validateCapture(
      JSON.parse(captureBytes.toString("utf8")),
      expected,
      descriptor.runSummaryRoot,
      executionPolicy.durationClass,
      scenario.playback,
    );
    requireValue(
      rootJson(capture) === descriptor.terminalCaptureRoot,
      "terminal capture root mismatch",
    );
    return { index, expected, descriptor, transcript, capture };
  });
  const sharedCaptureDurationMs = Math.max(
    ...loaded.map((entry) => entry.capture.durationMs),
  );
  requireValue(
    sharedCaptureDurationMs <= executionPolicy.maximumSeconds * 1000,
    "native capture duration exceeds its declared class",
  );
  for (const { index, expected, transcript, capture } of loaded) {
    const { projected, scene, publicProjection } = projection(
      capture,
      transcript,
      manifest.demo,
      expected,
      executionPolicy.durationClass,
      sharedCaptureDurationMs,
      scenario.compositionMode ?? PRESENTATION_FRAMED,
    );
    const suffix = index === 0 ? "" : "-720p";
    fs.writeFileSync(
      path.join(output, `complete-transcript${suffix}.txt`),
      transcript,
    );
    fs.writeFileSync(
      path.join(output, `terminal-capture${suffix}.json`),
      stableJson(projected),
    );
    fs.writeFileSync(
      path.join(output, `scene${suffix}.json`),
      stableJson(scene),
    );
    fs.writeFileSync(
      path.join(output, `public-projection${suffix}.json`),
      stableJson(publicProjection),
    );
    set.push({
      id: expected.id,
      role: expected.role,
      transcript: `complete-transcript${suffix}.txt`,
      projection: `public-projection${suffix}.json`,
      scene: `scene${suffix}.json`,
      terminalCapture: `terminal-capture${suffix}.json`,
      captureRoot: rootJson(projected),
    });
  }
  requireValue(
    set[0].captureRoot !== set[1].captureRoot,
    "native rendition capture roots must differ",
  );
  fs.writeFileSync(
    path.join(output, "rendition-set.json"),
    stableJson({
      schema: "kungfu.auditable-demo.rendition-set/v1",
      renditions: set,
      authority: {
        classification: "capture-routing-metadata",
        grants: [],
        nonAuthorities: [
          "publication-authority",
          "runtime-authority",
          ...NON_AUTHORITIES,
        ],
      },
    }),
  );
  return {
    demoId: manifest.demo.id,
    captureRoot: declaredRoot,
    renditionRoots: set.map((entry) => entry.captureRoot),
  };
}
