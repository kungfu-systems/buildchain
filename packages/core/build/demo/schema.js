import {
  DIGEST_PATTERN,
  invariant,
  sha256,
  readRegular,
  decodeUtf8,
  readJson,
  exactKeys,
  integer,
  text,
} from "./io.js";

export const REQUIRED_ADAPTER_FILES = [
  "complete-transcript.txt",
  "public-projection.json",
  "scene.json",
];

export const OPTIONAL_ADAPTER_FILES = [
  "terminal-capture.json",
  "complete-transcript-720p.txt",
  "public-projection-720p.json",
  "scene-720p.json",
  "terminal-capture-720p.json",
  "rendition-set.json",
];

export const MAX_TERMINAL_CAPTURE_BYTES = 4 * 1024 * 1024;

export const MAX_TERMINAL_CAPTURE_EVENTS = 10_000;

export const STANDARD_MAX_DURATION_MS = 60_000;

export const LONG_FORM_MAX_DURATION_MS = 180_000;

export const LONG_FORM_MAX_FPS = 10;

export const MAX_RENDER_FRAMES = 1_800;

export function validateScene(value) {
  exactKeys(
    value,
    ["schema", "id", "width", "height", "fps", "durationMs", "title"],
    [
      "durationClass",
      "compositionMode",
      "commandLabel",
      "background",
      "accent",
    ],
    "scene",
  );
  invariant(
    value.schema === "build-images.demo-scene/v1",
    "unsupported scene schema",
  );
  invariant(
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.id),
    "scene.id is invalid",
  );
  integer(value.width, 640, 1920, "scene.width");
  integer(value.height, 360, 1080, "scene.height");
  const durationClass = value.durationClass ?? "standard";
  invariant(
    durationClass === "standard" || durationClass === "long-form",
    "scene.durationClass is invalid",
  );
  const compositionMode = value.compositionMode ?? "presentation-framed";
  invariant(
    compositionMode === "presentation-framed" ||
      compositionMode === "terminal-fill",
    "scene.compositionMode is invalid",
  );
  const maximumDurationMs =
    durationClass === "long-form"
      ? LONG_FORM_MAX_DURATION_MS
      : STANDARD_MAX_DURATION_MS;
  const maximumFps = durationClass === "long-form" ? LONG_FORM_MAX_FPS : 30;
  integer(value.fps, 1, maximumFps, "scene.fps");
  integer(value.durationMs, 500, maximumDurationMs, "scene.durationMs");
  invariant(
    Math.ceil((value.durationMs / 1000) * value.fps) <= MAX_RENDER_FRAMES,
    "scene exceeds the deterministic source-frame bound",
  );
  text(value.title, 1, 120, "scene.title");
  if (value.commandLabel !== undefined)
    text(value.commandLabel, 0, 160, "scene.commandLabel");
  for (const key of ["background", "accent"]) {
    if (value[key] !== undefined)
      invariant(
        /^#[0-9a-fA-F]{6}$/.test(value[key]),
        `scene.${key} is invalid`,
      );
  }
  return {
    schema: value.schema,
    id: value.id,
    width: value.width,
    height: value.height,
    fps: value.fps,
    ...(value.durationClass === undefined ? {} : { durationClass }),
    compositionMode,
    durationMs: value.durationMs,
    title: value.title,
    commandLabel: value.commandLabel ?? "",
    background: (value.background ?? "#10151f").toLowerCase(),
    accent: (value.accent ?? "#67e8a5").toLowerCase(),
  };
}

export function validateProjection(value, scene, transcriptLineCount) {
  exactKeys(
    value,
    ["schema", "evidenceClass", "claimBoundary", "cues"],
    [],
    "projection",
  );
  invariant(
    value.schema === "build-images.demo-projection/v1",
    "unsupported projection schema",
  );
  text(value.evidenceClass, 1, 120, "projection.evidenceClass");
  text(value.claimBoundary, 1, 500, "projection.claimBoundary");
  invariant(
    Array.isArray(value.cues) &&
      value.cues.length > 0 &&
      value.cues.length <= 240,
    "projection.cues is invalid",
  );
  for (const [index, cue] of value.cues.entries()) {
    exactKeys(
      cue,
      ["startMs", "endMs", "transcriptLines"],
      ["annotation"],
      `projection.cues[${index}]`,
    );
    integer(
      cue.startMs,
      0,
      scene.durationMs - 1,
      `projection.cues[${index}].startMs`,
    );
    integer(cue.endMs, 1, scene.durationMs, `projection.cues[${index}].endMs`);
    invariant(
      cue.endMs > cue.startMs,
      `projection.cues[${index}] has a non-positive interval`,
    );
    invariant(
      Array.isArray(cue.transcriptLines) &&
        cue.transcriptLines.length > 0 &&
        cue.transcriptLines.length <= 80,
      `projection.cues[${index}].transcriptLines is invalid`,
    );
    const lines = new Set();
    for (const line of cue.transcriptLines) {
      integer(
        line,
        1,
        transcriptLineCount,
        `projection.cues[${index}] transcript line`,
      );
      invariant(
        !lines.has(line),
        `projection.cues[${index}] repeats transcript line ${line}`,
      );
      lines.add(line);
    }
    if (cue.annotation !== undefined)
      text(cue.annotation, 0, 200, `projection.cues[${index}].annotation`);
  }
  return {
    schema: value.schema,
    evidenceClass: value.evidenceClass,
    claimBoundary: value.claimBoundary,
    cues: value.cues.map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      transcriptLines: cue.transcriptLines,
      annotation: cue.annotation ?? "",
    })),
  };
}

export const RENDITION_VALIDATION_HELPERS = {
  decodeBase64,
  decodeUtf8,
  digestPattern: DIGEST_PATTERN,
  exactKeys,
  integer,
  invariant,
  maxBytes: MAX_TERMINAL_CAPTURE_BYTES,
  maxEvents: MAX_TERMINAL_CAPTURE_EVENTS,
  readJson,
  readRegular,
  sha256,
  text,
  validateProjection,
  validateScene,
};

export function validateSourceCoordinate(value) {
  exactKeys(
    value,
    [
      "schema",
      "repository",
      "runId",
      "runAttempt",
      "sourceSha",
      "id",
      "nodeId",
      "name",
      "digest",
      "sizeInBytes",
      "createdAt",
      "expiresAt",
    ],
    [],
    "sourceArtifact",
  );
  invariant(
    value.schema === "buildchain.github-artifact-coordinate/v1",
    "unsupported source artifact coordinate schema",
  );
  invariant(
    /^[^/\s]+\/[^/\s]+$/.test(value.repository),
    "sourceArtifact.repository is invalid",
  );
  for (const key of ["runId", "runAttempt", "id"]) {
    invariant(
      /^[1-9][0-9]*$/.test(value[key]),
      `sourceArtifact.${key} is invalid`,
    );
  }
  invariant(
    /^[0-9a-f]{40}$/.test(value.sourceSha),
    "sourceArtifact.sourceSha is invalid",
  );
  text(value.nodeId, 1, 256, "sourceArtifact.nodeId");
  text(value.name, 1, 256, "sourceArtifact.name");
  invariant(!/[\0\r\n]/.test(value.name), "sourceArtifact.name is invalid");
  invariant(
    DIGEST_PATTERN.test(value.digest),
    "sourceArtifact.digest is invalid",
  );
  integer(
    value.sizeInBytes,
    0,
    Number.MAX_SAFE_INTEGER,
    "sourceArtifact.sizeInBytes",
  );
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  invariant(Number.isFinite(createdAt), "sourceArtifact.createdAt is invalid");
  invariant(
    Number.isFinite(expiresAt) && expiresAt > createdAt,
    "sourceArtifact.expiresAt is invalid",
  );
  return value;
}

export function decodeBase64(value, label) {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_TERMINAL_CAPTURE_BYTES * 2 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      ),
    `${label} must be canonical base64`,
  );
  const decoded = Buffer.from(value, "base64");
  invariant(
    decoded.toString("base64") === value,
    `${label} must be canonical base64`,
  );
  return decoded;
}
