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
const MAX_LONG_FORM_RENDERER_MANIFEST_BYTES = 32 * 1024 * 1024;

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
      && scene.durationMs <= 180000
      && Number.isInteger(scene?.fps)
      && scene.fps >= 1
      && scene.fps <= 10
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
  const maximumDurationMs = scene.durationClass === "long-form" ? 180000 : 60000;
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
