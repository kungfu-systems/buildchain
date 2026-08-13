import fs from "node:fs";
import path from "node:path";

const TERMINAL_CAPTURE_NON_AUTHORITIES = [
  "first-party-identity",
  "system-identity",
  "kfd-compliance",
  "product-system-metadata",
  "package-metadata",
  "registry-history",
  "scan-output",
  "standalone-generation",
];
const RENDITION_SET_NON_AUTHORITIES = [
  "publication-authority",
  "runtime-authority",
  ...TERMINAL_CAPTURE_NON_AUTHORITIES,
];
const MAX_BUNDLE_MEMBER_BYTES = 8 * 1024 * 1024;
export const MAX_LONG_FORM_RENDERER_MANIFEST_BYTES = 64 * 1024 * 1024;
export const LONG_FORM_MAX_DURATION_MS = 360_000;
export const LONG_FORM_MAX_FPS = 10;
export const MAX_RENDER_FRAMES = 1_800;
const PRESENTATION_FRAMED = "presentation-framed";
const TERMINAL_FILL = "terminal-fill";
const GEOMETRY_TOLERANCE = 0.001;

export function boundedLongFormFps(durationMs) {
  return Math.max(1, Math.min(LONG_FORM_MAX_FPS, Math.floor((MAX_RENDER_FRAMES * 1000) / durationMs)));
}

function closeEnough(left, right, tolerance = GEOMETRY_TOLERANCE) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function validateContentViewport(composition, expected, expectedMode, label, helpers) {
  const { exactKeys, invariant } = helpers;
  const viewport = composition.contentViewport;
  exactKeys(viewport, ["x", "y", "width", "height", "fillRatio"], [], `${label}.contentViewport`);
  invariant(
    [viewport.x, viewport.y, viewport.width, viewport.height, viewport.fillRatio].every(Number.isFinite),
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.x >= 0 && viewport.y >= 0 && viewport.width > 0 && viewport.height > 0,
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.x + viewport.width <= expected.width + GEOMETRY_TOLERANCE
      && viewport.y + viewport.height <= expected.height + GEOMETRY_TOLERANCE,
    `${label} content viewport is malformed or out of bounds`,
  );
  invariant(
    viewport.fillRatio > 0
      && viewport.fillRatio <= 1
      && closeEnough(viewport.fillRatio, (viewport.width * viewport.height) / (expected.width * expected.height), 0.000001),
    `${label} content viewport is malformed or out of bounds`,
  );
  if (expectedMode === TERMINAL_FILL) {
    invariant(
      closeEnough(viewport.x, 0)
        && closeEnough(viewport.y, 0)
        && closeEnough(viewport.width, expected.width)
        && closeEnough(viewport.height, expected.height)
        && closeEnough(viewport.fillRatio, 1, 0.000001),
      `${label} does not provide a full-frame terminal viewport`,
    );
  }
}

function validateTerminalGeometry(composition, expected, expectedMode, label, helpers) {
  const { exactKeys, invariant } = helpers;
  const geometry = composition.terminalGeometry;
  if (expected.columns == null || expected.rows == null) {
    invariant(geometry === null, `${label} unexpectedly declares terminal cell geometry`);
    return;
  }
  exactKeys(
    geometry,
    ["columns", "rows", "cellWidth", "cellHeight", "fontSize", "lineHeight", "layout"],
    [],
    `${label}.terminalGeometry`,
  );
  invariant(
    geometry.columns === expected.columns && geometry.rows === expected.rows,
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  invariant(
    [geometry.cellWidth, geometry.cellHeight, geometry.fontSize, geometry.lineHeight]
      .every((value) => Number.isFinite(value) && value > 0),
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  invariant(
    geometry.layout === (expectedMode === TERMINAL_FILL ? "exact-grid" : "presentation-flow"),
    `${label} terminal cell geometry is malformed or rendition-mismatched`,
  );
  if (expectedMode === TERMINAL_FILL) {
    invariant(
      closeEnough(geometry.cellWidth * geometry.columns, expected.width)
        && closeEnough(geometry.cellHeight * geometry.rows, expected.height)
        && closeEnough(geometry.lineHeight, geometry.cellHeight),
      `${label} terminal cell geometry does not resolve to the full frame`,
    );
  }
}

function validateCompositionFrameSet(frameSet, expected, expectedMode, multiple, index, helpers) {
  const { exactKeys, invariant } = helpers;
  const label = `renderer composition frame set ${index}`;
  invariant(frameSet && typeof frameSet === "object", `${label} is missing`);
  invariant(
    multiple
      ? frameSet.id === expected.id
        && frameSet.role === expected.role
        && frameSet.width === expected.width
        && frameSet.height === expected.height
      : frameSet.width === expected.width && frameSet.height === expected.height,
    multiple
      ? `${label} does not match the requested rendition`
      : `${label} dimensions do not match the requested scene`,
  );
  const composition = frameSet.composition;
  exactKeys(composition, ["mode", "contentViewport", "terminalGeometry"], [], `${label}.composition`);
  invariant(composition.mode === expectedMode, `${label} mode drifted from the requested scene`);
  validateContentViewport(composition, expected, expectedMode, label, helpers);
  validateTerminalGeometry(composition, expected, expectedMode, label, helpers);
  return composition;
}

export function validateRendererComposition(manifest, renditions, helpers) {
  const { exactKeys, invariant } = helpers;
  invariant(Array.isArray(renditions) && renditions.length >= 1, "renderer composition requires declared renditions");
  const expectedMode = renditions[0].compositionMode ?? PRESENTATION_FRAMED;
  invariant(
    (expectedMode === PRESENTATION_FRAMED || expectedMode === TERMINAL_FILL)
      && renditions.every((entry) => (entry.compositionMode ?? PRESENTATION_FRAMED) === expectedMode),
    "requested rendition composition modes do not match",
  );
  const version = String(manifest.renderer?.contractVersion || "").split(".").map(Number);
  invariant(
    version.length === 3 && version.every(Number.isInteger) && version[0] === 1,
    "renderer contract version is unsupported",
  );
  const supportsCompositionEvidence = version[1] >= 4;
  if (!supportsCompositionEvidence) {
    invariant(expectedMode === PRESENTATION_FRAMED, "renderer contract does not support composition evidence");
    const sourceFrames = manifest.derivation?.sourceFrames;
    const frameSets = manifest.derivation?.sourceFrameSets;
    invariant(
      manifest.policy?.compositionMode === undefined
        && sourceFrames?.composition === undefined
        && (!Array.isArray(frameSets) || frameSets.every((entry) => entry?.composition === undefined)),
      "legacy renderer contract cannot declare composition evidence",
    );
    return { mode: expectedMode, frameSets: [], evidence: "legacy-presentation-default" };
  }
  invariant(manifest.policy?.compositionMode === expectedMode, "renderer composition policy drifted from the requested scene");
  const sourceFrames = manifest.derivation?.sourceFrames;
  const frameSets = renditions.length === 1
    ? [sourceFrames]
    : manifest.derivation?.sourceFrameSets;
  invariant(Array.isArray(frameSets) && frameSets.length === renditions.length, "renderer composition frame-set evidence is missing");
  const compositions = frameSets.map((frameSet, index) => validateCompositionFrameSet(
    frameSet,
    renditions[index],
    expectedMode,
    renditions.length > 1,
    index,
    helpers,
  ));
  if (renditions.length > 1) {
    invariant(
      JSON.stringify(sourceFrames?.composition) === JSON.stringify(frameSets[0].composition),
      "renderer primary composition evidence drifted between sourceFrames and sourceFrameSets",
    );
  }
  return { mode: expectedMode, frameSets: compositions };
}

export function rendererCompositionRenditions(expectedInputs, primaryScene, helpers) {
  const { invariant, readJson } = helpers;
  if (expectedInputs.renditionSet) {
    const set = validateRenditionSet(path.dirname(expectedInputs.renditionSet), helpers);
    invariant(set, "renderer expected rendition set is missing");
    return set.renditions.map((rendition) => ({
      id: rendition.id,
      role: rendition.role,
      width: rendition.scene.width,
      height: rendition.scene.height,
      columns: rendition.capture.dimensions.columns,
      rows: rendition.capture.dimensions.rows,
      compositionMode: rendition.scene.compositionMode,
    }));
  }
  const terminal = expectedInputs.terminalCapture
    ? validateTerminalCapture(
      readJson(expectedInputs.terminalCapture, "renderer expected terminal capture"),
      primaryScene,
      helpers,
    )
    : null;
  return [{
    width: primaryScene.width,
    height: primaryScene.height,
    columns: terminal?.dimensions.columns ?? null,
    rows: terminal?.dimensions.rows ?? null,
    compositionMode: primaryScene.compositionMode,
  }];
}

export function validateRendererCompositionInputs(manifest, expectedInputs, helpers) {
  const { invariant, readJson, validateScene } = helpers;
  if (expectedInputs.renditionSet) {
    invariant(
      manifest.derivation?.policy === "independent-native-frame-sets/v1",
      "renderer did not use independent native frame sets",
    );
    invariant(
      Array.isArray(manifest.inputs?.renditions)
        && manifest.inputs.renditions.length === 2
        && manifest.inputs.renditions[0]?.role === "primary"
        && manifest.inputs.renditions[1]?.role === "responsive"
        && manifest.inputs.renditions[0]?.terminalCapture?.root
          !== manifest.inputs.renditions[1]?.terminalCapture?.root,
      "renderer native rendition inputs are not independently bound",
    );
  }
  const primaryScene = validateScene(readJson(expectedInputs.scene, "renderer expected scene"));
  return validateRendererComposition(
    manifest,
    rendererCompositionRenditions(expectedInputs, primaryScene, helpers),
    helpers,
  );
}

function validateLongFormManifestRendition(entry, declaration, index, helpers) {
  const { digestPattern, invariant, maxBytes, maxEvents } = helpers;
  const scene = entry?.scene?.path;
  const capture = entry?.terminalCapture;
  invariant(
    entry?.id === declaration.id
      && entry?.role === declaration.role
      && scene?.durationClass === "long-form"
      && scene?.width === declaration.width
      && scene?.height === declaration.height
      && Number.isInteger(scene?.durationMs)
      && scene.durationMs >= 500
      && scene.durationMs <= LONG_FORM_MAX_DURATION_MS
      && Number.isInteger(scene?.fps)
      && scene.fps >= 1
      && scene.fps <= LONG_FORM_MAX_FPS
      && Math.ceil((scene.durationMs / 1000) * scene.fps) <= MAX_RENDER_FRAMES
      && capture?.schema === "kungfu.terminal-capture/v1"
      && digestPattern.test(capture?.root)
      && Number.isInteger(capture?.durationMs)
      && capture.durationMs >= 500
      && capture.durationMs <= scene.durationMs
      && scene.durationMs - capture.durationMs <= 2000
      && Number.isInteger(capture?.events)
      && capture.events >= 1
      && capture.events <= maxEvents
      && Number.isInteger(capture?.bytes)
      && capture.bytes >= 1
      && capture.bytes <= maxBytes,
    `oversized renderer manifest rendition ${index} is not bounded long-form evidence`,
  );
}

export function readRendererManifest(filePath, helpers) {
  const { decodeUtf8, invariant, readRegular } = helpers;
  const bytes = readRegular(filePath, "renderer manifest", MAX_LONG_FORM_RENDERER_MANIFEST_BYTES);
  let manifest;
  try {
    manifest = JSON.parse(decodeUtf8(bytes, "renderer manifest"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("renderer manifest must be valid JSON");
    throw error;
  }
  invariant(manifest.schema === "build-images.auditable-demo-render/v1", "unexpected renderer manifest schema");
  if (bytes.length > MAX_BUNDLE_MEMBER_BYTES) {
    const renditions = manifest.inputs?.renditions;
    invariant(Array.isArray(renditions) && renditions.length === 2, "oversized renderer manifest requires exactly two bounded long-form native renditions");
    const expected = [
      { id: "1080p", role: "primary", width: 1920, height: 1080 },
      { id: "720p", role: "responsive", width: 1280, height: 720 },
    ];
    renditions.forEach((entry, index) => validateLongFormManifestRendition(entry, expected[index], index, helpers));
  }
  return { bytes, manifest };
}
export function validateTerminalCapture(value, scene, helpers) {
  const { decodeBase64, digestPattern, exactKeys, integer, invariant, maxBytes, maxEvents, text } = helpers;
  exactKeys(
    value,
    ["schema", "command", "dimensions", "durationMs", "encoding", "events", "completion", "exitCode", "authority"],
    [],
    "terminalCapture",
  );
  invariant(value.schema === "kungfu.terminal-capture/v1", "unsupported terminal capture schema");
  text(value.command, 1, 160, "terminalCapture.command");
  exactKeys(value.dimensions, ["columns", "rows"], [], "terminalCapture.dimensions");
  integer(value.dimensions.columns, 80, 200, "terminalCapture.dimensions.columns");
  integer(value.dimensions.rows, 24, 80, "terminalCapture.dimensions.rows");
  const maximumDurationMs = scene.durationClass === "long-form" ? LONG_FORM_MAX_DURATION_MS : 60000;
  const durationMs = integer(value.durationMs, 500, maximumDurationMs, "terminalCapture.durationMs");
  invariant(
    durationMs <= scene.durationMs && scene.durationMs - durationMs <= 2000,
    "terminal capture duration must end within two seconds of the scene",
  );
  invariant(value.encoding === "base64", "terminalCapture.encoding must be base64");
  invariant(
    Array.isArray(value.events) && value.events.length > 0 && value.events.length <= maxEvents,
    `terminalCapture.events must contain 1 through ${maxEvents} events`,
  );
  let previousAtMs = -1;
  let totalBytes = 0;
  for (const [index, event] of value.events.entries()) {
    exactKeys(event, ["atMs", "data"], [], `terminalCapture.events[${index}]`);
    const atMs = integer(event.atMs, 0, durationMs - 1, `terminalCapture.events[${index}].atMs`);
    invariant(atMs >= previousAtMs, "terminal capture event timestamps must be monotonic");
    invariant(index > 0 || atMs === 0, "the first terminal capture event must start at zero");
    previousAtMs = atMs;
    totalBytes += decodeBase64(event.data, `terminalCapture.events[${index}].data`).length;
    invariant(totalBytes <= maxBytes, "terminal capture exceeds the 4 MiB byte bound");
  }
  exactKeys(value.completion, ["schema", "status", "reportRoot", "eventCount"], [], "terminalCapture.completion");
  invariant(
    /^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u.test(value.completion.schema)
      && value.completion.status === "qualified"
      && digestPattern.test(value.completion.reportRoot),
    "terminal capture completion sentinel is not a qualified versioned result",
  );
  integer(value.completion.eventCount, 1, 100_000, "terminalCapture.completion.eventCount");
  invariant(value.exitCode === 0, "terminal capture exitCode must be zero");
  exactKeys(value.authority, ["classification", "grants", "nonAuthorities"], [], "terminalCapture.authority");
  invariant(value.authority.classification === "volatile-terminal-observation", "terminal capture authority classification must remain observation-only");
  invariant(Array.isArray(value.authority.grants) && value.authority.grants.length === 0, "terminal capture must not grant authority");
  invariant(
    JSON.stringify(value.authority.nonAuthorities) === JSON.stringify(TERMINAL_CAPTURE_NON_AUTHORITIES),
    "terminal capture must declare every identity and metadata non-authority",
  );
  return value;
}

export function validateRenditionSet(output, helpers) {
  const { decodeUtf8, exactKeys, invariant, maxBytes, readJson, readRegular, sha256, validateProjection, validateScene } = helpers;
  const manifestPath = path.join(output, "rendition-set.json");
  if (!fs.existsSync(manifestPath)) return null;
  const value = readJson(manifestPath, "rendition set");
  exactKeys(value, ["schema", "renditions", "authority"], [], "renditionSet");
  invariant(value.schema === "kungfu.auditable-demo.rendition-set/v1", "unsupported rendition set schema");
  exactKeys(value.authority, ["classification", "grants", "nonAuthorities"], [], "renditionSet.authority");
  invariant(
    value.authority.classification === "capture-routing-metadata"
      && Array.isArray(value.authority.grants)
      && value.authority.grants.length === 0
      && JSON.stringify(value.authority.nonAuthorities) === JSON.stringify(RENDITION_SET_NON_AUTHORITIES),
    "rendition set authority boundary is invalid",
  );
  invariant(Array.isArray(value.renditions) && value.renditions.length === 2, "rendition set must contain exactly two captures");
  const expected = [
    {
      id: "1080p", role: "primary", transcript: "complete-transcript.txt",
      projection: "public-projection.json", scene: "scene.json", terminalCapture: "terminal-capture.json",
      width: 1920, height: 1080,
    },
    {
      id: "720p", role: "responsive", transcript: "complete-transcript-720p.txt",
      projection: "public-projection-720p.json", scene: "scene-720p.json", terminalCapture: "terminal-capture-720p.json",
      width: 1280, height: 720,
    },
  ];
  const normalized = value.renditions.map((entry, index) => {
    const label = `renditionSet.renditions[${index}]`;
    exactKeys(entry, ["id", "role", "transcript", "projection", "scene", "terminalCapture", "captureRoot"], [], label);
    const declaration = expected[index];
    for (const key of ["id", "role", "transcript", "projection", "scene", "terminalCapture"]) {
      invariant(entry[key] === declaration[key], `${label}.${key} is not the exact native rendition contract`);
    }
    const transcriptBytes = readRegular(path.join(output, entry.transcript), `${label} transcript`, 4 * 1024 * 1024);
    const transcript = decodeUtf8(transcriptBytes, `${label} transcript`).replace(/\r\n/g, "\n");
    invariant(transcript.trim().length > 0, `${label} transcript must not be empty`);
    const lines = transcript.endsWith("\n") ? transcript.slice(0, -1).split("\n") : transcript.split("\n");
    const scene = validateScene(readJson(path.join(output, entry.scene), `${label} scene`));
    invariant(scene.width === declaration.width && scene.height === declaration.height, `${label} scene dimensions are not native`);
    const projection = validateProjection(readJson(path.join(output, entry.projection), `${label} projection`), scene, lines.length);
    const captureBytes = readRegular(path.join(output, entry.terminalCapture), `${label} terminal capture`, maxBytes);
    const capture = validateTerminalCapture(JSON.parse(decodeUtf8(captureBytes, `${label} terminal capture`)), scene, helpers);
    invariant(entry.captureRoot === sha256(captureBytes), `${label}.captureRoot mismatch`);
    return { ...entry, files: Object.fromEntries(["transcript", "projection", "scene", "terminalCapture"].map((key) => [key, entry[key]])), transcript, lines, scene, projection, capture };
  });
  invariant(normalized[0].captureRoot !== normalized[1].captureRoot, "native rendition capture roots must be distinct");
  invariant(
    (normalized[0].scene.durationClass ?? "standard") === (normalized[1].scene.durationClass ?? "standard"),
    "native rendition duration classes must match",
  );
  invariant(
    JSON.stringify(normalized[0].capture.dimensions) !== JSON.stringify(normalized[1].capture.dimensions),
    "native rendition PTY dimensions must be distinct",
  );
  invariant(
    normalized[0].projection.evidenceClass === normalized[1].projection.evidenceClass
      && normalized[0].projection.claimBoundary === normalized[1].projection.claimBoundary,
    "native rendition evidence boundaries must match",
  );
  return { schema: value.schema, renditions: normalized, authority: value.authority };
}
