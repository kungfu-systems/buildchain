import {
  IMAGE_PATTERN,
  DIGEST_PATTERN,
  MAX_BUNDLE_MEMBER_BYTES,
  invariant,
  sha256,
  readRegular,
  readJson,
  writeJson,
  resolveInside,
  exactKeys,
  integer,
  text,
  required,
  semanticRoot,
} from "./io.js";
import { RENDITION_VALIDATION_HELPERS } from "./schema.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRendererManifest } from "./renditions.js";

export function inspectIsoBmffFastStart(filePath) {
  const bytes = readRegular(filePath, "MP4 rendition", MAX_BUNDLE_MEMBER_BYTES);
  let offset = 0;
  let moovOffset = -1;
  let mdatOffset = -1;
  let ftypSeen = false;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      invariant(
        offset + 16 <= bytes.length,
        "MP4 extended box header is truncated",
      );
      const extended = bytes.readBigUInt64BE(offset + 8);
      invariant(
        extended <= BigInt(Number.MAX_SAFE_INTEGER),
        "MP4 box size is too large",
      );
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    invariant(
      size >= headerSize && offset + size <= bytes.length,
      "MP4 box layout is invalid",
    );
    if (type === "ftyp") ftypSeen = true;
    if (type === "moov" && moovOffset === -1) moovOffset = offset;
    if (type === "mdat" && mdatOffset === -1) mdatOffset = offset;
    offset += size;
  }
  invariant(
    offset === bytes.length && ftypSeen,
    "MP4 top-level boxes are incomplete",
  );
  if (moovOffset === -1 || mdatOffset === -1) return "missing-moov-or-mdat";
  return moovOffset < mdatOffset ? "moov-before-mdat" : "mdat-before-moov";
}

export function rationalNumber(value) {
  const match = /^([0-9]+)\/([0-9]+)$/.exec(String(value || ""));
  if (!match || Number(match[2]) === 0) return 0;
  return Number(match[1]) / Number(match[2]);
}

export function inspectMediaFile(filePath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  invariant(
    !result.error && result.status === 0,
    `ffprobe failed for ${path.basename(filePath)}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `ffprobe returned invalid JSON for ${path.basename(filePath)}`,
    );
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videos = streams.filter((entry) => entry.codec_type === "video");
  const audioStreams = streams.filter(
    (entry) => entry.codec_type === "audio",
  ).length;
  invariant(
    videos.length === 1,
    `${path.basename(filePath)} must contain exactly one video or image stream`,
  );
  const video = videos[0];
  const formatNames = String(parsed.format?.format_name || "").split(",");
  let container = formatNames.includes("mp4") ? "mp4" : "";
  if (formatNames.includes("webm")) container = "webm";
  if (formatNames.includes("gif") || video.codec_name === "gif")
    container = "gif";
  if (video.codec_name === "png") container = "png";
  if (video.codec_name === "webp") container = "webp";
  if (video.codec_name === "av1" && formatNames.includes("avif"))
    container = "avif";
  const duration = Number(parsed.format?.duration || 0);
  return {
    container,
    videoCodec: String(video.codec_name || ""),
    pixelFormat: String(video.pix_fmt || ""),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
    frameRate: rationalNumber(video.avg_frame_rate),
    audioStreams,
    progressiveDownload:
      container === "mp4"
        ? inspectIsoBmffFastStart(filePath)
        : "not-applicable",
  };
}

export function inspectRendererMedia(request) {
  const renderOutput = path.resolve(required(request, "renderOutput"));
  const output = path.resolve(required(request, "output"));
  const rendererImage = required(request, "rendererImage");
  invariant(
    IMAGE_PATTERN.test(rendererImage),
    "renderer image must use an immutable sha256 coordinate",
  );
  invariant(
    !fs.existsSync(output),
    "media inspection output must not already exist",
  );
  const { manifest } = readRendererManifest(
    path.join(renderOutput, "manifest.json"),
    RENDITION_VALIDATION_HELPERS,
  );
  invariant(
    manifest.renderer?.image === rendererImage,
    "renderer manifest image coordinate mismatch",
  );
  const members = Object.keys(manifest.outputs || {})
    .filter((name) => name !== "media-probe.json")
    .sort()
    .map((name) => {
      const target = resolveInside(
        renderOutput,
        name,
        "media inspection member",
      );
      const bytes = readRegular(target, name, MAX_BUNDLE_MEMBER_BYTES);
      return {
        path: name,
        root: sha256(bytes),
        bytes: bytes.length,
        facts: inspectMediaFile(target),
      };
    });
  const body = {
    schema: "buildchain.auditable-demo-media-inspection/v1",
    rendererImage,
    members,
  };
  writeJson(output, { ...body, inspectionRoot: semanticRoot(body) });
}

export function loadMediaInspection(filePath, renderOutput, rendererImage) {
  const value = readJson(filePath, "media inspection");
  exactKeys(
    value,
    ["schema", "rendererImage", "members", "inspectionRoot"],
    [],
    "mediaInspection",
  );
  invariant(
    value.schema === "buildchain.auditable-demo-media-inspection/v1",
    "unsupported media inspection schema",
  );
  invariant(
    value.rendererImage === rendererImage,
    "media inspection renderer image mismatch",
  );
  invariant(
    Array.isArray(value.members),
    "mediaInspection.members must be an array",
  );
  const body = {
    schema: value.schema,
    rendererImage: value.rendererImage,
    members: value.members,
  };
  invariant(
    value.inspectionRoot === semanticRoot(body),
    "media inspection root mismatch",
  );
  const byPath = new Map();
  for (const [index, entry] of value.members.entries()) {
    exactKeys(
      entry,
      ["path", "root", "bytes", "facts"],
      [],
      `mediaInspection.members[${index}]`,
    );
    text(entry.path, 1, 256, `mediaInspection.members[${index}].path`);
    invariant(
      DIGEST_PATTERN.test(entry.root),
      `mediaInspection.members[${index}].root is invalid`,
    );
    integer(
      entry.bytes,
      1,
      MAX_BUNDLE_MEMBER_BYTES,
      `mediaInspection.members[${index}].bytes`,
    );
    exactKeys(
      entry.facts,
      [
        "container",
        "videoCodec",
        "pixelFormat",
        "width",
        "height",
        "durationMs",
        "frameRate",
        "audioStreams",
        "progressiveDownload",
      ],
      [],
      `mediaInspection.members[${index}].facts`,
    );
    const facts = {
      container: text(
        entry.facts.container,
        1,
        32,
        `mediaInspection.members[${index}].facts.container`,
      ),
      videoCodec: text(
        entry.facts.videoCodec,
        1,
        32,
        `mediaInspection.members[${index}].facts.videoCodec`,
      ),
      pixelFormat: text(
        entry.facts.pixelFormat,
        0,
        32,
        `mediaInspection.members[${index}].facts.pixelFormat`,
      ),
      width: integer(
        entry.facts.width,
        1,
        16384,
        `mediaInspection.members[${index}].facts.width`,
      ),
      height: integer(
        entry.facts.height,
        1,
        16384,
        `mediaInspection.members[${index}].facts.height`,
      ),
      durationMs: integer(
        entry.facts.durationMs,
        0,
        3_600_000,
        `mediaInspection.members[${index}].facts.durationMs`,
      ),
      frameRate: entry.facts.frameRate,
      audioStreams: integer(
        entry.facts.audioStreams,
        0,
        64,
        `mediaInspection.members[${index}].facts.audioStreams`,
      ),
      progressiveDownload: text(
        entry.facts.progressiveDownload,
        1,
        32,
        `mediaInspection.members[${index}].facts.progressiveDownload`,
      ),
    };
    invariant(
      Number.isFinite(facts.frameRate) &&
        facts.frameRate >= 0 &&
        facts.frameRate <= 240,
      `mediaInspection.members[${index}].facts.frameRate is out of range`,
    );
    invariant(
      !byPath.has(entry.path),
      `duplicate media inspection member: ${entry.path}`,
    );
    const target = resolveInside(
      renderOutput,
      entry.path,
      "media inspection member",
    );
    const bytes = readRegular(target, entry.path, MAX_BUNDLE_MEMBER_BYTES);
    invariant(
      entry.root === sha256(bytes),
      `media inspection member root mismatch: ${entry.path}`,
    );
    invariant(
      entry.bytes === bytes.length,
      `media inspection member byte count mismatch: ${entry.path}`,
    );
    byPath.set(entry.path, facts);
  }
  return {
    inspectionRoot: value.inspectionRoot,
    inspectMedia: (target) => {
      const facts = byPath.get(
        path.relative(renderOutput, target).split(path.sep).join("/"),
      );
      invariant(
        facts,
        `media inspection facts are missing: ${path.basename(target)}`,
      );
      return facts;
    },
  };
}
