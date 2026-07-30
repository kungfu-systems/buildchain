#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_BUNDLE_MEMBER_BYTES = 8 * 1024 * 1024;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_PROFILE_CATALOG = path.resolve(
  SCRIPT_DIRECTORY,
  "../contracts/auditable-demo-media-profiles-v1.json",
);
const REQUIRED_ADAPTER_FILES = [
  "complete-transcript.txt",
  "public-projection.json",
  "scene.json",
];
const OPTIONAL_ADAPTER_FILES = ["terminal-capture.json"];
const MAX_TERMINAL_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_TERMINAL_CAPTURE_EVENTS = 10_000;
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

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function stableJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

function readRegular(filePath, label, maximumBytes = 8 * 1024 * 1024) {
  const metadata = fs.lstatSync(filePath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  invariant(metadata.size <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`);
  return fs.readFileSync(filePath);
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(decodeUtf8(readRegular(filePath, label), label));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} must be valid JSON`);
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, stableJson(value));
}

function resolveInside(root, relativePath, label) {
  invariant(typeof relativePath === "string" && relativePath.length > 0, `${label} is required`);
  invariant(!path.isAbsolute(relativePath), `${label} must be repository-relative`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, resolved);
  invariant(relation && !relation.startsWith("..") && !path.isAbsolute(relation), `${label} escapes its root`);
  return resolved;
}

function ensureEmptyDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true });
  const metadata = fs.lstatSync(directory);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} must be a non-symlink directory`);
  invariant(fs.readdirSync(directory).length === 0, `${label} must be initially empty`);
}

function listFiles(root, prefix = "") {
  const directory = path.join(root, prefix);
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  const files = [];
  for (const entry of entries) {
    invariant(!entry.isSymbolicLink(), `bundle member must not be a symlink: ${path.join(prefix, entry.name)}`);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else {
      invariant(entry.isFile(), `bundle member must be a regular file: ${relative}`);
      files.push(relative.split(path.sep).join("/"));
    }
  }
  return files;
}

function writeChecksums(root, checksumName = "checksums.sha256") {
  const names = listFiles(root).filter((name) => name !== checksumName);
  const rows = names.map((name) => `${sha256(fs.readFileSync(path.join(root, name))).slice(7)}  ${name}`);
  const bytes = `${rows.join("\n")}\n`;
  fs.writeFileSync(path.join(root, checksumName), bytes);
  return sha256(Buffer.from(bytes));
}

function verifyChecksums(root, checksumName = "checksums.sha256") {
  const bytes = readRegular(path.join(root, checksumName), checksumName);
  const text = decodeUtf8(bytes, checksumName);
  invariant(text.endsWith("\n"), `${checksumName} must end with a newline`);
  const rows = text.slice(0, -1).split("\n").filter(Boolean);
  const declared = new Set();
  for (const row of rows) {
    const match = /^([0-9a-f]{64})  ([^\0\r\n]+)$/.exec(row);
    invariant(match, `invalid checksum row: ${row}`);
    const member = match[2];
    const target = resolveInside(root, member, "checksum member");
    invariant(!declared.has(member), `duplicate checksum member: ${member}`);
    declared.add(member);
    invariant(
      sha256(readRegular(target, member, MAX_BUNDLE_MEMBER_BYTES)).slice(7) === match[1],
      `checksum mismatch: ${member}`,
    );
  }
  const actual = listFiles(root).filter((name) => name !== checksumName);
  invariant(
    actual.length === declared.size && actual.every((name) => declared.has(name)),
    `${checksumName} must cover every bundle member exactly once`,
  );
  return sha256(bytes);
}

function exactKeys(value, required, optional, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) invariant(allowed.has(key), `${label}.${key} is not declared`);
  for (const key of required) invariant(key in value, `${label}.${key} is required`);
}

function integer(value, minimum, maximum, label) {
  invariant(Number.isInteger(value) && value >= minimum && value <= maximum, `${label} is out of range`);
  return value;
}

function text(value, minimum, maximum, label) {
  invariant(typeof value === "string" && value.length >= minimum && value.length <= maximum, `${label} is invalid`);
  return value;
}

function decodeBase64(value, label) {
  invariant(
    typeof value === "string"
      && value.length > 0
      && value.length <= MAX_TERMINAL_CAPTURE_BYTES * 2
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    `${label} must be canonical base64`,
  );
  const decoded = Buffer.from(value, "base64");
  invariant(decoded.toString("base64") === value, `${label} must be canonical base64`);
  return decoded;
}

function validateScene(value) {
  exactKeys(
    value,
    ["schema", "id", "width", "height", "fps", "durationMs", "title"],
    ["commandLabel", "background", "accent"],
    "scene",
  );
  invariant(value.schema === "build-images.demo-scene/v1", "unsupported scene schema");
  invariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.id), "scene.id is invalid");
  integer(value.width, 640, 1920, "scene.width");
  integer(value.height, 360, 1080, "scene.height");
  integer(value.fps, 1, 30, "scene.fps");
  integer(value.durationMs, 500, 60000, "scene.durationMs");
  text(value.title, 1, 120, "scene.title");
  if (value.commandLabel !== undefined) text(value.commandLabel, 0, 160, "scene.commandLabel");
  for (const key of ["background", "accent"]) {
    if (value[key] !== undefined) invariant(/^#[0-9a-fA-F]{6}$/.test(value[key]), `scene.${key} is invalid`);
  }
  return {
    schema: value.schema,
    id: value.id,
    width: value.width,
    height: value.height,
    fps: value.fps,
    durationMs: value.durationMs,
    title: value.title,
    commandLabel: value.commandLabel ?? "",
    background: (value.background ?? "#10151f").toLowerCase(),
    accent: (value.accent ?? "#67e8a5").toLowerCase(),
  };
}

function validateProjection(value, scene, transcriptLineCount) {
  exactKeys(value, ["schema", "evidenceClass", "claimBoundary", "cues"], [], "projection");
  invariant(value.schema === "build-images.demo-projection/v1", "unsupported projection schema");
  text(value.evidenceClass, 1, 120, "projection.evidenceClass");
  text(value.claimBoundary, 1, 500, "projection.claimBoundary");
  invariant(Array.isArray(value.cues) && value.cues.length > 0 && value.cues.length <= 240, "projection.cues is invalid");
  for (const [index, cue] of value.cues.entries()) {
    exactKeys(cue, ["startMs", "endMs", "transcriptLines"], ["annotation"], `projection.cues[${index}]`);
    integer(cue.startMs, 0, scene.durationMs - 1, `projection.cues[${index}].startMs`);
    integer(cue.endMs, 1, scene.durationMs, `projection.cues[${index}].endMs`);
    invariant(cue.endMs > cue.startMs, `projection.cues[${index}] has a non-positive interval`);
    invariant(
      Array.isArray(cue.transcriptLines) && cue.transcriptLines.length > 0 && cue.transcriptLines.length <= 80,
      `projection.cues[${index}].transcriptLines is invalid`,
    );
    const lines = new Set();
    for (const line of cue.transcriptLines) {
      integer(line, 1, transcriptLineCount, `projection.cues[${index}] transcript line`);
      invariant(!lines.has(line), `projection.cues[${index}] repeats transcript line ${line}`);
      lines.add(line);
    }
    if (cue.annotation !== undefined) text(cue.annotation, 0, 200, `projection.cues[${index}].annotation`);
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

function validateTerminalCapture(value, scene) {
  exactKeys(
    value,
    [
      "schema",
      "command",
      "dimensions",
      "durationMs",
      "encoding",
      "events",
      "completion",
      "exitCode",
      "authority",
    ],
    [],
    "terminalCapture",
  );
  invariant(value.schema === "kungfu.terminal-capture/v1", "unsupported terminal capture schema");
  text(value.command, 1, 160, "terminalCapture.command");
  exactKeys(value.dimensions, ["columns", "rows"], [], "terminalCapture.dimensions");
  integer(value.dimensions.columns, 80, 200, "terminalCapture.dimensions.columns");
  integer(value.dimensions.rows, 24, 80, "terminalCapture.dimensions.rows");
  const durationMs = integer(value.durationMs, 500, 60000, "terminalCapture.durationMs");
  invariant(
    durationMs <= scene.durationMs && scene.durationMs - durationMs <= 2000,
    "terminal capture duration must end within two seconds of the scene",
  );
  invariant(value.encoding === "base64", "terminalCapture.encoding must be base64");
  invariant(
    Array.isArray(value.events)
      && value.events.length > 0
      && value.events.length <= MAX_TERMINAL_CAPTURE_EVENTS,
    `terminalCapture.events must contain 1 through ${MAX_TERMINAL_CAPTURE_EVENTS} events`,
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
    invariant(totalBytes <= MAX_TERMINAL_CAPTURE_BYTES, "terminal capture exceeds the 4 MiB byte bound");
  }
  exactKeys(
    value.completion,
    ["schema", "status", "reportRoot", "eventCount"],
    [],
    "terminalCapture.completion",
  );
  invariant(
    value.completion.schema === "kungfu.agent-work-lab.tui-autoplay/v1"
      && value.completion.status === "qualified"
      && DIGEST_PATTERN.test(value.completion.reportRoot),
    "terminal capture completion sentinel is not a qualified Agent Work Lab autoplay",
  );
  integer(value.completion.eventCount, 1, 100_000, "terminalCapture.completion.eventCount");
  invariant(value.exitCode === 0, "terminal capture exitCode must be zero");
  exactKeys(value.authority, ["classification", "grants", "nonAuthorities"], [], "terminalCapture.authority");
  invariant(
    value.authority.classification === "volatile-terminal-observation",
    "terminal capture authority classification must remain observation-only",
  );
  invariant(
    Array.isArray(value.authority.grants) && value.authority.grants.length === 0,
    "terminal capture must not grant authority",
  );
  invariant(
    JSON.stringify(value.authority.nonAuthorities) === JSON.stringify(TERMINAL_CAPTURE_NON_AUTHORITIES),
    "terminal capture must declare every identity and metadata non-authority",
  );
  return value;
}

function validateSourceCoordinate(value) {
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
  invariant(value.schema === "buildchain.github-artifact-coordinate/v1", "unsupported source artifact coordinate schema");
  invariant(/^[^/\s]+\/[^/\s]+$/.test(value.repository), "sourceArtifact.repository is invalid");
  for (const key of ["runId", "runAttempt", "id"]) {
    invariant(/^[1-9][0-9]*$/.test(value[key]), `sourceArtifact.${key} is invalid`);
  }
  invariant(/^[0-9a-f]{40}$/.test(value.sourceSha), "sourceArtifact.sourceSha is invalid");
  text(value.nodeId, 1, 256, "sourceArtifact.nodeId");
  text(value.name, 1, 256, "sourceArtifact.name");
  invariant(!/[\0\r\n]/.test(value.name), "sourceArtifact.name is invalid");
  invariant(DIGEST_PATTERN.test(value.digest), "sourceArtifact.digest is invalid");
  integer(value.sizeInBytes, 0, Number.MAX_SAFE_INTEGER, "sourceArtifact.sizeInBytes");
  const createdAt = Date.parse(value.createdAt);
  const expiresAt = Date.parse(value.expiresAt);
  invariant(Number.isFinite(createdAt), "sourceArtifact.createdAt is invalid");
  invariant(Number.isFinite(expiresAt) && expiresAt > createdAt, "sourceArtifact.expiresAt is invalid");
  return value;
}

function validateAdapterOutput(output, strict = true) {
  for (const name of REQUIRED_ADAPTER_FILES) readRegular(path.join(output, name), `adapter output ${name}`, 4 * 1024 * 1024);
  const transcript = decodeUtf8(
    readRegular(path.join(output, "complete-transcript.txt"), "complete transcript", 4 * 1024 * 1024),
    "complete transcript",
  ).replace(/\r\n/g, "\n");
  invariant(transcript.trim().length > 0, "complete transcript must not be empty");
  const lines = transcript.endsWith("\n") ? transcript.slice(0, -1).split("\n") : transcript.split("\n");
  invariant(lines.length <= 20000, "complete transcript exceeds 20000 lines");
  const scene = validateScene(readJson(path.join(output, "scene.json"), "scene"));
  const projection = validateProjection(
    readJson(path.join(output, "public-projection.json"), "projection"),
    scene,
    lines.length,
  );
  const terminalCapturePath = path.join(output, "terminal-capture.json");
  const terminalCapture = fs.existsSync(terminalCapturePath)
    ? validateTerminalCapture(readJson(terminalCapturePath, "terminal capture"), scene)
    : null;
  if (strict) {
    const allowed = new Set([...REQUIRED_ADAPTER_FILES, ...OPTIONAL_ADAPTER_FILES]);
    for (const member of listFiles(output)) invariant(allowed.has(member), `undeclared adapter output: ${member}`);
  }
  return {
    transcript: transcript.endsWith("\n") ? transcript : `${transcript}\n`,
    lines,
    scene,
    projection,
    terminalCapture,
  };
}

function parseArguments(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(key?.startsWith("--") && value !== undefined, `invalid argument near ${key || "<empty>"}`);
    invariant(!(key in values), `duplicate argument: ${key}`);
    values[key] = value;
  }
  return { command, values };
}

function required(values, key) {
  invariant(values[key], `${key} is required`);
  return values[key];
}

function appendOutputs(outputPath, entries) {
  if (!outputPath) return;
  const rows = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(outputPath, `${rows.join("\n")}\n`);
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function runAdapter(values) {
  const sourceRoot = path.resolve(required(values, "--source-root"));
  const artifactRoot = path.resolve(required(values, "--artifact-root"));
  const output = path.resolve(required(values, "--output"));
  const diagnostics = path.resolve(required(values, "--diagnostics"));
  const sourceCoordinate = path.resolve(required(values, "--source-coordinate"));
  const adapterRelative = required(values, "--adapter");
  const adapter = resolveInside(sourceRoot, adapterRelative, "adapter path");
  const metadata = fs.lstatSync(adapter);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), "adapter must be a regular non-symlink file");
  invariant((metadata.mode & 0o111) !== 0, "adapter must be executable");
  invariant(fs.realpathSync(adapter).startsWith(`${fs.realpathSync(sourceRoot)}${path.sep}`), "adapter resolves outside source");
  validateSourceCoordinate(readJson(sourceCoordinate, "source artifact coordinate"));
  ensureEmptyDirectory(output, "adapter output");
  fs.mkdirSync(diagnostics, { recursive: true });
  const disposableHome = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-auditable-demo-home-"));
  const environment = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: disposableHome,
    XDG_CACHE_HOME: path.join(disposableHome, ".cache"),
    XDG_CONFIG_HOME: path.join(disposableHome, ".config"),
    XDG_DATA_HOME: path.join(disposableHome, ".local", "share"),
    XDG_STATE_HOME: path.join(disposableHome, ".local", "state"),
    npm_config_prefix: path.join(disposableHome, ".npm-prefix"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "true",
    SOURCE_DATE_EPOCH: "0",
  };
  try {
    const result = spawnSync(
      adapter,
      ["--artifact-root", artifactRoot, "--output", output, "--source-coordinate", sourceCoordinate],
      { cwd: sourceRoot, env: environment, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(diagnostics, "adapter.stdout.log"), result.stdout || "");
    fs.writeFileSync(path.join(diagnostics, "adapter.stderr.log"), result.stderr || result.error?.message || "");
    invariant(!result.error && result.status === 0, `adapter failed with exit code ${result.status ?? "spawn-error"}`);
    const normalized = validateAdapterOutput(output);
    fs.writeFileSync(path.join(output, "complete-transcript.txt"), normalized.transcript);
    writeJson(path.join(output, "scene.json"), normalized.scene);
    writeJson(path.join(output, "public-projection.json"), normalized.projection);
    if (normalized.terminalCapture) {
      writeJson(path.join(output, "terminal-capture.json"), normalized.terminalCapture);
    }
    writeJson(path.join(diagnostics, "adapter.json"), {
      schema: "buildchain.auditable-demo-adapter-execution/v1",
      path: adapterRelative,
      sha256: sha256(readRegular(adapter, "adapter", 4 * 1024 * 1024)),
      exitCode: 0,
    });
  } finally {
    fs.rmSync(disposableHome, { recursive: true, force: true });
  }
}

function prepareSmoke(values) {
  const adapterOutput = path.resolve(required(values, "--adapter-output"));
  const output = path.resolve(required(values, "--output"));
  const normalized = validateAdapterOutput(adapterOutput);
  ensureEmptyDirectory(output, "smoke input");
  const firstCue = normalized.projection.cues[0];
  const identifier = `${normalized.scene.id.slice(0, 52)}.gate-smoke`.slice(0, 64);
  const scene = {
    schema: "build-images.demo-scene/v1",
    id: identifier,
    width: 640,
    height: 360,
    fps: 5,
    durationMs: 1000,
    title: `${normalized.scene.title.slice(0, 96)} gate smoke`,
    commandLabel: "buildchain auditable demo gate",
    background: normalized.scene.background || "#10151f",
    accent: normalized.scene.accent || "#67e8a5",
  };
  const projection = {
    schema: "build-images.demo-projection/v1",
    evidenceClass: normalized.projection.evidenceClass,
    claimBoundary: normalized.projection.claimBoundary,
    cues: [{
      startMs: 0,
      endMs: 1000,
      transcriptLines: firstCue.transcriptLines.slice(0, 8),
      annotation: "bounded renderer compatibility smoke",
    }],
  };
  fs.writeFileSync(path.join(output, "complete-transcript.txt"), normalized.transcript);
  writeJson(path.join(output, "scene.json"), scene);
  writeJson(path.join(output, "public-projection.json"), projection);
}

function semanticRoot(value) {
  return sha256(Buffer.from(stableJson(value)));
}

function validateBudgetBasis(entry, label) {
  exactKeys(
    entry.budgetBasis,
    ["evidence", "observedPath", "observedBytes", "multiplier", "rounding"],
    [],
    `${label}.budgetBasis`,
  );
  invariant(
    entry.budgetBasis.evidence === "contracts/evidence/auditable-demo-web-delivery-v1.json",
    `${label}.budgetBasis.evidence is unsupported`,
  );
  text(entry.budgetBasis.observedPath, 1, 128, `${label}.budgetBasis.observedPath`);
  const observedBytes = integer(
    entry.budgetBasis.observedBytes,
    1,
    MAX_BUNDLE_MEMBER_BYTES,
    `${label}.budgetBasis.observedBytes`,
  );
  const multiplier = integer(entry.budgetBasis.multiplier, 1, 64, `${label}.budgetBasis.multiplier`);
  invariant(entry.budgetBasis.rounding === "next-power-of-two", `${label}.budgetBasis.rounding is unsupported`);
  const expected = 2 ** Math.ceil(Math.log2(observedBytes * multiplier));
  invariant(entry.maximumBytes === expected, `${label}.maximumBytes does not match its measured budget basis`);
}

function loadMediaProfile(profileId) {
  const catalog = readJson(MEDIA_PROFILE_CATALOG, "auditable demo media profile catalog");
  invariant(
    catalog.schema === "buildchain.auditable-demo-media-profiles/v1",
    "unsupported media profile catalog",
  );
  invariant(catalog.profiles && typeof catalog.profiles === "object", "media profile catalog is invalid");
  const seen = new Set();
  const resolve = (identifier) => {
    invariant(!seen.has(identifier), `media profile inheritance cycle: ${identifier}`);
    const declared = catalog.profiles[identifier];
    invariant(declared && typeof declared === "object", `unsupported media profile: ${identifier}`);
    seen.add(identifier);
    const inherited = declared.extends ? resolve(declared.extends) : {
      mode: "archive",
      renditions: [],
      singletonRoles: [],
      additionalRenditions: null,
    };
    seen.delete(identifier);
    const byPath = new Map(inherited.renditions.map((entry) => [entry.path, entry]));
    for (const entry of declared.renditions || []) {
      invariant(entry && typeof entry === "object" && typeof entry.path === "string", `${identifier} rendition is invalid`);
      byPath.set(entry.path, { ...(byPath.get(entry.path) || {}), ...entry });
    }
    return {
      mode: declared.mode || inherited.mode,
      renditions: [...byPath.values()],
      singletonRoles: [...new Set([...(inherited.singletonRoles || []), ...(declared.singletonRoles || [])])],
      additionalRenditions: declared.additionalRenditions || inherited.additionalRenditions || null,
    };
  };
  const resolved = resolve(profileId);
  const profile = { id: profileId, ...resolved };
  for (const [index, entry] of profile.renditions.entries()) {
    if (profile.mode === "web-delivery") {
      invariant(entry.budgetBasis, `${profileId}.renditions[${index}].budgetBasis is required`);
      validateBudgetBasis(entry, `${profileId}.renditions[${index}]`);
    }
  }
  return {
    catalog,
    catalogRoot: semanticRoot(catalog),
    profile,
    profileRoot: semanticRoot(profile),
  };
}

function inspectIsoBmffFastStart(filePath) {
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
      invariant(offset + 16 <= bytes.length, "MP4 extended box header is truncated");
      const extended = bytes.readBigUInt64BE(offset + 8);
      invariant(extended <= BigInt(Number.MAX_SAFE_INTEGER), "MP4 box size is too large");
      size = Number(extended);
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    invariant(size >= headerSize && offset + size <= bytes.length, "MP4 box layout is invalid");
    if (type === "ftyp") ftypSeen = true;
    if (type === "moov" && moovOffset === -1) moovOffset = offset;
    if (type === "mdat" && mdatOffset === -1) mdatOffset = offset;
    offset += size;
  }
  invariant(offset === bytes.length && ftypSeen, "MP4 top-level boxes are incomplete");
  if (moovOffset === -1 || mdatOffset === -1) return "missing-moov-or-mdat";
  return moovOffset < mdatOffset ? "moov-before-mdat" : "mdat-before-moov";
}

function rationalNumber(value) {
  const match = /^([0-9]+)\/([0-9]+)$/.exec(String(value || ""));
  if (!match || Number(match[2]) === 0) return 0;
  return Number(match[1]) / Number(match[2]);
}

function inspectMediaFile(filePath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate",
      "-of", "json",
      filePath,
    ],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  invariant(!result.error && result.status === 0, `ffprobe failed for ${path.basename(filePath)}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`ffprobe returned invalid JSON for ${path.basename(filePath)}`);
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videos = streams.filter((entry) => entry.codec_type === "video");
  const audioStreams = streams.filter((entry) => entry.codec_type === "audio").length;
  invariant(videos.length === 1, `${path.basename(filePath)} must contain exactly one video or image stream`);
  const video = videos[0];
  const formatNames = String(parsed.format?.format_name || "").split(",");
  let container = formatNames.includes("mp4") ? "mp4" : "";
  if (formatNames.includes("webm")) container = "webm";
  if (formatNames.includes("gif") || video.codec_name === "gif") container = "gif";
  if (video.codec_name === "png") container = "png";
  if (video.codec_name === "webp") container = "webp";
  if (video.codec_name === "av1" && formatNames.includes("avif")) container = "avif";
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
    progressiveDownload: container === "mp4" ? inspectIsoBmffFastStart(filePath) : "not-applicable",
  };
}

function inspectRendererMedia(values) {
  const renderOutput = path.resolve(required(values, "--render-output"));
  const output = path.resolve(required(values, "--output"));
  const rendererImage = required(values, "--renderer-image");
  invariant(IMAGE_PATTERN.test(rendererImage), "renderer image must use an immutable sha256 coordinate");
  invariant(!fs.existsSync(output), "media inspection output must not already exist");
  const manifest = readJson(path.join(renderOutput, "manifest.json"), "renderer manifest");
  invariant(manifest.schema === "build-images.auditable-demo-render/v1", "unexpected renderer manifest schema");
  invariant(manifest.renderer?.image === rendererImage, "renderer manifest image coordinate mismatch");
  const members = Object.keys(manifest.outputs || {})
    .filter((name) => name !== "media-probe.json")
    .sort()
    .map((name) => {
      const target = resolveInside(renderOutput, name, "media inspection member");
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

function qualifyMediaFixture(values) {
  const renderOutput = path.resolve(required(values, "--render-output"));
  const output = path.resolve(required(values, "--output"));
  const rendererImage = required(values, "--renderer-image");
  const rendererSourceRepository = required(values, "--renderer-source-repository");
  const rendererSourceRef = required(values, "--renderer-source-ref");
  const rendererSourceSha = required(values, "--renderer-source-sha");
  const mediaProfile = required(values, "--media-profile");
  invariant(IMAGE_PATTERN.test(rendererImage), "renderer image must use an immutable sha256 coordinate");
  invariant(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(rendererSourceRepository), "renderer source repository is invalid");
  invariant(/^refs\/tags\/[a-zA-Z0-9._-]+$/.test(rendererSourceRef), "renderer source ref must be an exact tag ref");
  invariant(/^[0-9a-f]{40}$/.test(rendererSourceSha), "renderer source SHA must be exact");
  invariant(!fs.existsSync(output), "media fixture evidence output must not already exist");
  const mediaInspection = loadMediaInspection(
    path.resolve(required(values, "--media-inspection")),
    renderOutput,
    rendererImage,
  );
  const verified = verifyRendererOutput(renderOutput, rendererImage, {
    scene: path.join(renderOutput, "scene.json"),
    transcript: path.join(renderOutput, "complete-transcript.txt"),
    projection: path.join(renderOutput, "public-projection.json"),
  }, {
    mediaProfile,
    inspectMedia: mediaInspection.inspectMedia,
    inspectionRoot: mediaInspection.inspectionRoot,
  });
  const body = {
    schema: "buildchain.auditable-demo-media-profile-fixture/v1",
    renderer: {
      image: rendererImage,
      sourceRepository: rendererSourceRepository,
      sourceRef: rendererSourceRef,
      sourceSha: rendererSourceSha,
    },
    inputs: Object.fromEntries(
      ["complete-transcript.txt", "public-projection.json", "scene.json"].map((name) => [
        name,
        sha256(readRegular(path.join(renderOutput, name), `fixture ${name}`)),
      ]),
    ),
    rendererManifestRoot: sha256(readRegular(path.join(renderOutput, "manifest.json"), "renderer manifest")),
    qualification: verified.qualification,
  };
  writeJson(output, { ...body, evidenceRoot: semanticRoot(body) });
}

function loadMediaInspection(filePath, renderOutput, rendererImage) {
  const value = readJson(filePath, "media inspection");
  exactKeys(value, ["schema", "rendererImage", "members", "inspectionRoot"], [], "mediaInspection");
  invariant(value.schema === "buildchain.auditable-demo-media-inspection/v1", "unsupported media inspection schema");
  invariant(value.rendererImage === rendererImage, "media inspection renderer image mismatch");
  invariant(Array.isArray(value.members), "mediaInspection.members must be an array");
  const body = {
    schema: value.schema,
    rendererImage: value.rendererImage,
    members: value.members,
  };
  invariant(value.inspectionRoot === semanticRoot(body), "media inspection root mismatch");
  const byPath = new Map();
  for (const [index, entry] of value.members.entries()) {
    exactKeys(entry, ["path", "root", "bytes", "facts"], [], `mediaInspection.members[${index}]`);
    text(entry.path, 1, 256, `mediaInspection.members[${index}].path`);
    invariant(DIGEST_PATTERN.test(entry.root), `mediaInspection.members[${index}].root is invalid`);
    integer(entry.bytes, 1, MAX_BUNDLE_MEMBER_BYTES, `mediaInspection.members[${index}].bytes`);
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
      container: text(entry.facts.container, 1, 32, `mediaInspection.members[${index}].facts.container`),
      videoCodec: text(entry.facts.videoCodec, 1, 32, `mediaInspection.members[${index}].facts.videoCodec`),
      pixelFormat: text(entry.facts.pixelFormat, 0, 32, `mediaInspection.members[${index}].facts.pixelFormat`),
      width: integer(entry.facts.width, 1, 16384, `mediaInspection.members[${index}].facts.width`),
      height: integer(entry.facts.height, 1, 16384, `mediaInspection.members[${index}].facts.height`),
      durationMs: integer(entry.facts.durationMs, 0, 3_600_000, `mediaInspection.members[${index}].facts.durationMs`),
      frameRate: entry.facts.frameRate,
      audioStreams: integer(entry.facts.audioStreams, 0, 64, `mediaInspection.members[${index}].facts.audioStreams`),
      progressiveDownload: text(
        entry.facts.progressiveDownload,
        1,
        32,
        `mediaInspection.members[${index}].facts.progressiveDownload`,
      ),
    };
    invariant(
      Number.isFinite(facts.frameRate) && facts.frameRate >= 0 && facts.frameRate <= 240,
      `mediaInspection.members[${index}].facts.frameRate is out of range`,
    );
    invariant(!byPath.has(entry.path), `duplicate media inspection member: ${entry.path}`);
    const target = resolveInside(renderOutput, entry.path, "media inspection member");
    const bytes = readRegular(target, entry.path, MAX_BUNDLE_MEMBER_BYTES);
    invariant(entry.root === sha256(bytes), `media inspection member root mismatch: ${entry.path}`);
    invariant(entry.bytes === bytes.length, `media inspection member byte count mismatch: ${entry.path}`);
    byPath.set(entry.path, facts);
  }
  return {
    inspectionRoot: value.inspectionRoot,
    inspectMedia: (target) => {
      const facts = byPath.get(path.relative(renderOutput, target).split(path.sep).join("/"));
      invariant(facts, `media inspection facts are missing: ${path.basename(target)}`);
      return facts;
    },
  };
}

function constraintsForAdditionalRendition(entry, policy) {
  const common = {
    path: entry.path,
    role: entry.role,
    mimeType: entry.mimeType,
    maximumBytes: policy.maximumBytesByMimeType[entry.mimeType],
    audioStreams: 0,
  };
  if (entry.mimeType === "video/mp4") {
    return { ...common, container: "mp4", videoCodec: "h264", pixelFormat: "yuv420p", progressiveDownload: "moov-before-mdat" };
  }
  if (entry.mimeType === "video/webm") {
    return { ...common, container: "webm", videoCodec: "vp9", pixelFormat: "yuv420p" };
  }
  if (entry.mimeType === "image/webp") return { ...common, container: "webp", videoCodec: "webp" };
  if (entry.mimeType === "image/avif") return { ...common, container: "avif", videoCodec: "av1" };
  throw new Error(`additional rendition MIME type is not allowed: ${entry.mimeType}`);
}

function qualifyRendererOutput(renderOutput, manifest, scene, profileId, inspectMedia, inspectionRoot = "") {
  const loaded = loadMediaProfile(profileId);
  const { profile, catalog } = loaded;
  const outputs = manifest.outputs || {};
  const rules = profile.renditions.map((entry) => ({ ...entry }));
  const knownPaths = new Set(rules.map((entry) => entry.path));
  const declaration = manifest.webDelivery;
  if (declaration !== undefined) {
    exactKeys(declaration, ["schema", "renditions"], [], "manifest.webDelivery");
    invariant(
      declaration.schema === "build-images.auditable-demo-web-delivery/v1",
      "unsupported renderer web-delivery declaration",
    );
    invariant(Array.isArray(declaration.renditions), "manifest.webDelivery.renditions must be an array");
    for (const [index, entry] of declaration.renditions.entries()) {
      exactKeys(entry, ["path", "role", "mimeType"], [], `manifest.webDelivery.renditions[${index}]`);
      invariant(!knownPaths.has(entry.path), `renderer web-delivery path is already profile-owned: ${entry.path}`);
      const policy = profile.additionalRenditions;
      invariant(policy, `media profile ${profileId} does not admit additional renditions`);
      invariant(policy.allowedRoles.includes(entry.role), `additional rendition role is not allowed: ${entry.role}`);
      invariant(policy.allowedMimeTypes.includes(entry.mimeType), `additional rendition MIME type is not allowed: ${entry.mimeType}`);
      const maximumBytes = policy.maximumBytesByMimeType?.[entry.mimeType];
      integer(maximumBytes, 1, MAX_BUNDLE_MEMBER_BYTES, `media profile ${profileId} additional ${entry.mimeType} budget`);
      rules.push(constraintsForAdditionalRendition(entry, policy));
      knownPaths.add(entry.path);
    }
  }
  for (const name of Object.keys(outputs)) {
    if (name !== "media-probe.json") invariant(knownPaths.has(name), `unbound renderer output: ${name}`);
  }
  const singletonRoles = new Set(profile.singletonRoles || []);
  const observedRoles = new Set();
  const renditions = [];
  for (const rule of rules) {
    const declared = outputs[rule.path];
    invariant(declared && typeof declared === "object", `required renderer output is missing: ${rule.path}`);
    const target = resolveInside(renderOutput, rule.path, "renderer output path");
    const bytes = readRegular(target, rule.path, MAX_BUNDLE_MEMBER_BYTES);
    invariant(declared.root === sha256(bytes), `renderer manifest root mismatch: ${rule.path}`);
    invariant(declared.bytes === bytes.length, `renderer manifest byte count mismatch: ${rule.path}`);
    if (rule.maximumBytes !== undefined) {
      invariant(bytes.length <= rule.maximumBytes, `${rule.path} byte budget exceeded`);
    }
    if (singletonRoles.has(rule.role)) {
      invariant(!observedRoles.has(rule.role), `duplicate singleton role: ${rule.role}`);
      observedRoles.add(rule.role);
    }
    const facts = profile.mode === "web-delivery" ? inspectMedia(target) : {};
    if (profile.mode === "web-delivery") {
      invariant(facts && typeof facts === "object", `${rule.path} inspection is missing`);
      invariant(facts.container === rule.container, `${rule.path} container mismatch`);
      invariant(facts.videoCodec === rule.videoCodec, `${rule.path} video codec mismatch`);
      if (rule.pixelFormat) invariant(facts.pixelFormat === rule.pixelFormat, `${rule.path} pixel format mismatch`);
      invariant(facts.audioStreams === rule.audioStreams, `${rule.path} audio stream policy failed`);
      invariant(facts.width === scene.width && facts.height === scene.height, `${rule.path} dimensions mismatch`);
      if (facts.durationMs > 0) {
        invariant(
          Math.abs(facts.durationMs - scene.durationMs) <= catalog.qualification.durationToleranceMs,
          `${rule.path} duration mismatch`,
        );
      }
      if (rule.frameRatePolicy === "scene-exact") {
        invariant(Math.abs(facts.frameRate - scene.fps) < 0.001, `${rule.path} frame rate mismatch`);
      }
      if (rule.progressiveDownload) {
        invariant(
          facts.progressiveDownload === rule.progressiveDownload,
          `${rule.path} progressive download evidence mismatch`,
        );
      }
    }
    renditions.push({
      path: rule.path,
      role: rule.role,
      mimeType: rule.mimeType,
      root: declared.root,
      bytes: declared.bytes,
      maximumBytes: rule.maximumBytes || 0,
      ...facts,
    });
  }
  const body = {
    schema: "buildchain.auditable-demo-media-qualification/v1",
    profile: {
      id: profileId,
      mode: profile.mode,
      catalogRoot: loaded.catalogRoot,
      profileRoot: loaded.profileRoot,
    },
    inspectionRoot,
    renditions,
    nonClaims: catalog.qualification.nonClaims,
  };
  return { ...body, qualificationRoot: semanticRoot(body) };
}

function verifyRendererOutput(renderOutput, expectedImage, expectedInputs, options = {}) {
  invariant(IMAGE_PATTERN.test(expectedImage), "renderer image must use an immutable sha256 coordinate");
  const fixedMembers = [
    "checksums.sha256",
    "complete-transcript.txt",
    "manifest.json",
    "public-projection.json",
    "scene.json",
  ];
  verifyChecksums(renderOutput);
  const manifest = readJson(path.join(renderOutput, "manifest.json"), "renderer manifest");
  invariant(manifest.schema === "build-images.auditable-demo-render/v1", "unexpected renderer manifest schema");
  invariant(manifest.renderer?.image === expectedImage, "renderer manifest image coordinate mismatch");
  const outputNames = Object.keys(manifest.outputs || {}).sort();
  invariant(outputNames.includes("media-probe.json"), "renderer manifest must declare media-probe.json");
  const expectedMembers = [...new Set([...fixedMembers, ...outputNames])].sort();
  invariant(JSON.stringify(listFiles(renderOutput)) === JSON.stringify(expectedMembers), "renderer output member set is not exact");
  for (const name of outputNames) {
    invariant(!name.includes("\\") && !name.split("/").includes(".."), `renderer output path is invalid: ${name}`);
    const target = resolveInside(renderOutput, name, "renderer manifest output");
    const bytes = readRegular(target, name, MAX_BUNDLE_MEMBER_BYTES);
    const declared = manifest.outputs[name];
    invariant(declared?.root === sha256(bytes), `renderer manifest root mismatch: ${name}`);
    invariant(declared?.bytes === bytes.length, `renderer manifest byte count mismatch: ${name}`);
  }
  for (const [key, filePath] of Object.entries(expectedInputs)) {
    const observed = manifest.inputs?.[key]?.root;
    invariant(observed === sha256(readRegular(filePath, `${key} input`)), `renderer ${key} input root mismatch`);
  }
  const probe = readJson(path.join(renderOutput, "media-probe.json"), "media probe");
  invariant(probe.schema === "build-images.demo-media-probe/v1" && probe.passed === true, "renderer media probe failed");
  const qualification = qualifyRendererOutput(
    renderOutput,
    manifest,
    readJson(path.join(renderOutput, "scene.json"), "renderer scene"),
    options.mediaProfile || "archive-v1",
    options.inspectMedia || inspectMediaFile,
    options.inspectionRoot || "",
  );
  return { manifest, probe, qualification };
}

function finalizeGate(values) {
  const adapterOutput = path.resolve(required(values, "--adapter-output"));
  const smokeInput = path.resolve(required(values, "--smoke-input"));
  const smokeOutput = path.resolve(required(values, "--smoke-output"));
  const sourceCoordinatePath = path.resolve(required(values, "--source-coordinate"));
  const diagnostics = path.resolve(required(values, "--diagnostics"));
  const output = path.resolve(required(values, "--output"));
  const rendererImage = required(values, "--renderer-image");
  const adapterRelative = required(values, "--adapter");
  const sourceSha = required(values, "--source-sha");
  invariant(/^[0-9a-f]{40}$/.test(sourceSha), "source SHA must be exact");
  const normalized = validateAdapterOutput(adapterOutput);
  verifyRendererOutput(smokeOutput, rendererImage, {
    scene: path.join(smokeInput, "scene.json"),
    transcript: path.join(smokeInput, "complete-transcript.txt"),
    projection: path.join(smokeInput, "public-projection.json"),
  });
  const sourceCoordinate = validateSourceCoordinate(readJson(sourceCoordinatePath, "source artifact coordinate"));
  invariant(sourceCoordinate.sourceSha === sourceSha, "source artifact coordinate SHA mismatch");
  ensureEmptyDirectory(output, "gate bundle");
  fs.writeFileSync(path.join(output, "complete-transcript.txt"), normalized.transcript);
  writeJson(path.join(output, "scene.json"), normalized.scene);
  writeJson(path.join(output, "public-projection.json"), normalized.projection);
  if (normalized.terminalCapture) {
    copyFile(
      path.join(adapterOutput, "terminal-capture.json"),
      path.join(output, "terminal-capture.json"),
    );
  }
  copyFile(sourceCoordinatePath, path.join(output, "source-artifact.json"));
  copyFile(path.join(diagnostics, "adapter.json"), path.join(output, "adapter.json"));
  for (const name of listFiles(smokeOutput)) {
    copyFile(path.join(smokeOutput, name), path.join(output, "smoke", name));
  }
  writeJson(path.join(output, "gate-receipt.json"), {
    schema: "buildchain.auditable-demo-gate/v1",
    status: "passed",
    sourceRepository: sourceCoordinate.repository,
    sourceSha,
    sourceArtifact: {
      id: sourceCoordinate.id,
      name: sourceCoordinate.name,
      digest: sourceCoordinate.digest,
      runId: sourceCoordinate.runId,
      expiresAt: sourceCoordinate.expiresAt,
    },
    adapter: {
      path: adapterRelative,
      sha256: readJson(path.join(diagnostics, "adapter.json"), "adapter execution").sha256,
    },
    renderer: {
      image: rendererImage,
      smokeManifestRoot: sha256(readRegular(path.join(smokeOutput, "manifest.json"), "smoke manifest")),
    },
    qualifiedInputs: {
      transcript: sha256(readRegular(path.join(output, "complete-transcript.txt"), "transcript")),
      projection: sha256(readRegular(path.join(output, "public-projection.json"), "projection")),
      scene: sha256(readRegular(path.join(output, "scene.json"), "scene")),
      ...(normalized.terminalCapture
        ? {
          terminalCapture: {
            schema: normalized.terminalCapture.schema,
            root: sha256(readRegular(path.join(output, "terminal-capture.json"), "terminal capture")),
          },
        }
        : {}),
      evidenceClass: normalized.projection.evidenceClass,
      claimBoundary: normalized.projection.claimBoundary,
    },
  });
  const root = writeChecksums(output);
  const artifactName = `auditable-demo-gate-${sourceSha.slice(0, 12)}-${root.slice(7, 23)}`;
  appendOutputs(values["--github-output"], {
    "gate-root": root,
    "gate-artifact-name": artifactName,
  });
  process.stdout.write(stableJson({ status: "passed", root, artifactName }));
}

function verifyGate(values) {
  const bundle = path.resolve(required(values, "--bundle"));
  const expectedRoot = required(values, "--expected-root");
  const expectedImage = required(values, "--renderer-image");
  const expectedSourceSha = required(values, "--source-sha");
  invariant(DIGEST_PATTERN.test(expectedRoot), "expected gate root must be sha256");
  invariant(verifyChecksums(bundle) === expectedRoot, "gate bundle root mismatch");
  const receipt = readJson(path.join(bundle, "gate-receipt.json"), "gate receipt");
  invariant(receipt.schema === "buildchain.auditable-demo-gate/v1" && receipt.status === "passed", "gate did not pass");
  invariant(receipt.sourceSha === expectedSourceSha, "gate source SHA mismatch");
  invariant(receipt.renderer?.image === expectedImage, "gate renderer image mismatch");
  const normalized = validateAdapterOutput(bundle, false);
  invariant(
    receipt.qualifiedInputs?.transcript === sha256(readRegular(path.join(bundle, "complete-transcript.txt"), "transcript"))
      && receipt.qualifiedInputs?.projection === sha256(readRegular(path.join(bundle, "public-projection.json"), "projection"))
      && receipt.qualifiedInputs?.scene === sha256(readRegular(path.join(bundle, "scene.json"), "scene")),
    "gate qualified input roots mismatch",
  );
  const qualifiedCapture = receipt.qualifiedInputs?.terminalCapture;
  invariant(
    Boolean(qualifiedCapture) === Boolean(normalized.terminalCapture),
    "gate terminal capture presence drifted",
  );
  if (normalized.terminalCapture) {
    invariant(
      qualifiedCapture.schema === normalized.terminalCapture.schema
        && qualifiedCapture.root
          === sha256(readRegular(path.join(bundle, "terminal-capture.json"), "terminal capture")),
      "gate terminal capture root mismatch",
    );
  }
  invariant(receipt.qualifiedInputs.evidenceClass === normalized.projection.evidenceClass, "gate evidence class drifted");
}

function finalizeMedia(values) {
  const gateBundle = path.resolve(required(values, "--gate-bundle"));
  const renderOutput = path.resolve(required(values, "--render-output"));
  const output = path.resolve(required(values, "--output"));
  const rendererImage = required(values, "--renderer-image");
  const gateRoot = required(values, "--gate-root");
  const sourceSha = required(values, "--source-sha");
  const mediaProfile = values["--media-profile"] || "archive-v1";
  const selectedProfile = loadMediaProfile(mediaProfile).profile;
  const mediaInspectionPath = values["--media-inspection"]
    ? path.resolve(values["--media-inspection"])
    : "";
  const mediaInspection = selectedProfile.mode === "web-delivery"
    ? loadMediaInspection(
      required({ "--media-inspection": mediaInspectionPath }, "--media-inspection"),
      renderOutput,
      rendererImage,
    )
    : null;
  verifyGate({
    "--bundle": gateBundle,
    "--expected-root": gateRoot,
    "--renderer-image": rendererImage,
    "--source-sha": sourceSha,
  });
  const terminalCapturePath = path.join(gateBundle, "terminal-capture.json");
  const verifiedRenderer = verifyRendererOutput(renderOutput, rendererImage, {
    scene: path.join(gateBundle, "scene.json"),
    transcript: path.join(gateBundle, "complete-transcript.txt"),
    projection: path.join(gateBundle, "public-projection.json"),
    ...(fs.existsSync(terminalCapturePath)
      ? { terminalCapture: terminalCapturePath }
      : {}),
  }, {
    mediaProfile,
    inspectMedia: mediaInspection?.inspectMedia,
    inspectionRoot: mediaInspection?.inspectionRoot || "",
  });
  ensureEmptyDirectory(output, "media bundle");
  for (const name of listFiles(renderOutput)) {
    const destination = name === "checksums.sha256" ? "renderer-checksums.sha256" : name;
    copyFile(path.join(renderOutput, name), path.join(output, destination));
  }
  copyFile(path.join(gateBundle, "gate-receipt.json"), path.join(output, "gate-receipt.json"));
  if (mediaInspectionPath) copyFile(mediaInspectionPath, path.join(output, "media-inspection.json"));
  const commonReceipt = {
    status: "passed",
    sourceSha,
    qualifiedGateRoot: gateRoot,
    rendererImage,
    rendererManifestRoot: sha256(readRegular(path.join(renderOutput, "manifest.json"), "renderer manifest")),
  };
  const mediaReceipt = selectedProfile.mode === "archive"
    ? { schema: "buildchain.auditable-demo-media/v1", ...commonReceipt }
    : {
      schema: "buildchain.auditable-demo-media/v2",
      ...commonReceipt,
      qualification: verifiedRenderer.qualification,
      qualificationRoot: verifiedRenderer.qualification.qualificationRoot,
    };
  writeJson(path.join(output, "media-receipt.json"), mediaReceipt);
  const root = writeChecksums(output);
  const artifactName = `auditable-demo-media-${sourceSha.slice(0, 12)}-${root.slice(7, 23)}`;
  appendOutputs(values["--github-output"], {
    "media-root": root,
    "media-artifact-name": artifactName,
    "media-profile": mediaProfile,
    "media-qualification-root": verifiedRenderer.qualification.qualificationRoot,
  });
  process.stdout.write(stableJson({ status: "passed", root, artifactName }));
}

function main(argv) {
  const { command, values } = parseArguments(argv);
  switch (command) {
    case "run-adapter":
      return runAdapter(values);
    case "prepare-smoke":
      return prepareSmoke(values);
    case "finalize-gate":
      return finalizeGate(values);
    case "verify-gate":
      return verifyGate(values);
    case "finalize-media":
      return finalizeMedia(values);
    case "inspect-media":
      return inspectRendererMedia(values);
    case "qualify-media-fixture":
      return qualifyMediaFixture(values);
    default:
      throw new Error(`unknown command: ${command || "<empty>"}`);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`auditable-demo: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  finalizeGate,
  finalizeMedia,
  inspectIsoBmffFastStart,
  inspectMediaFile,
  inspectRendererMedia,
  qualifyMediaFixture,
  prepareSmoke,
  runAdapter,
  sha256,
  stableJson,
  validateAdapterOutput,
  validateSourceCoordinate,
  verifyChecksums,
  verifyGate,
  verifyRendererOutput,
  writeChecksums,
};
