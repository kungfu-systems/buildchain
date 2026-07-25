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
const REQUIRED_ADAPTER_FILES = [
  "complete-transcript.txt",
  "public-projection.json",
  "scene.json",
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
    invariant(sha256(readRegular(target, member)).slice(7) === match[1], `checksum mismatch: ${member}`);
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
  return value;
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
  if (strict) {
    const allowed = new Set(REQUIRED_ADAPTER_FILES);
    for (const member of listFiles(output)) invariant(allowed.has(member), `undeclared adapter output: ${member}`);
  }
  return { transcript: transcript.endsWith("\n") ? transcript : `${transcript}\n`, lines, scene, projection };
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
      { cwd: sourceRoot, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(diagnostics, "adapter.stdout.log"), result.stdout || "");
    fs.writeFileSync(path.join(diagnostics, "adapter.stderr.log"), result.stderr || result.error?.message || "");
    invariant(!result.error && result.status === 0, `adapter failed with exit code ${result.status ?? "spawn-error"}`);
    const normalized = validateAdapterOutput(output);
    fs.writeFileSync(path.join(output, "complete-transcript.txt"), normalized.transcript);
    writeJson(path.join(output, "scene.json"), normalized.scene);
    writeJson(path.join(output, "public-projection.json"), normalized.projection);
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

function verifyRendererOutput(renderOutput, expectedImage, expectedInputs) {
  invariant(IMAGE_PATTERN.test(expectedImage), "renderer image must use an immutable sha256 coordinate");
  const expectedMembers = [
    "checksums.sha256",
    "complete-transcript.txt",
    "demo.gif",
    "demo.mp4",
    "demo.webm",
    "manifest.json",
    "media-probe.json",
    "poster.png",
    "public-projection.json",
    "scene.json",
  ];
  invariant(
    JSON.stringify(listFiles(renderOutput)) === JSON.stringify(expectedMembers),
    "renderer output member set is not exact",
  );
  verifyChecksums(renderOutput);
  const manifest = readJson(path.join(renderOutput, "manifest.json"), "renderer manifest");
  invariant(manifest.schema === "build-images.auditable-demo-render/v1", "unexpected renderer manifest schema");
  invariant(manifest.renderer?.image === expectedImage, "renderer manifest image coordinate mismatch");
  invariant(
    JSON.stringify(Object.keys(manifest.outputs || {}).sort()) ===
      JSON.stringify(["demo.gif", "demo.mp4", "demo.webm", "media-probe.json", "poster.png"]),
    "renderer manifest output set is not exact",
  );
  for (const [key, filePath] of Object.entries(expectedInputs)) {
    const observed = manifest.inputs?.[key]?.root;
    invariant(observed === sha256(readRegular(filePath, `${key} input`)), `renderer ${key} input root mismatch`);
  }
  const probe = readJson(path.join(renderOutput, "media-probe.json"), "media probe");
  invariant(probe.schema === "build-images.demo-media-probe/v1" && probe.passed === true, "renderer media probe failed");
  return { manifest, probe };
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
  for (const name of REQUIRED_ADAPTER_FILES) copyFile(path.join(adapterOutput, name), path.join(output, name));
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
      transcript: sha256(readRegular(path.join(adapterOutput, "complete-transcript.txt"), "transcript")),
      projection: sha256(readRegular(path.join(adapterOutput, "public-projection.json"), "projection")),
      scene: sha256(readRegular(path.join(adapterOutput, "scene.json"), "scene")),
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
  invariant(receipt.qualifiedInputs.evidenceClass === normalized.projection.evidenceClass, "gate evidence class drifted");
}

function finalizeMedia(values) {
  const gateBundle = path.resolve(required(values, "--gate-bundle"));
  const renderOutput = path.resolve(required(values, "--render-output"));
  const output = path.resolve(required(values, "--output"));
  const rendererImage = required(values, "--renderer-image");
  const gateRoot = required(values, "--gate-root");
  const sourceSha = required(values, "--source-sha");
  verifyGate({
    "--bundle": gateBundle,
    "--expected-root": gateRoot,
    "--renderer-image": rendererImage,
    "--source-sha": sourceSha,
  });
  verifyRendererOutput(renderOutput, rendererImage, {
    scene: path.join(gateBundle, "scene.json"),
    transcript: path.join(gateBundle, "complete-transcript.txt"),
    projection: path.join(gateBundle, "public-projection.json"),
  });
  ensureEmptyDirectory(output, "media bundle");
  for (const name of listFiles(renderOutput)) {
    const destination = name === "checksums.sha256" ? "renderer-checksums.sha256" : name;
    copyFile(path.join(renderOutput, name), path.join(output, destination));
  }
  copyFile(path.join(gateBundle, "gate-receipt.json"), path.join(output, "gate-receipt.json"));
  writeJson(path.join(output, "media-receipt.json"), {
    schema: "buildchain.auditable-demo-media/v1",
    status: "passed",
    sourceSha,
    qualifiedGateRoot: gateRoot,
    rendererImage,
    rendererManifestRoot: sha256(readRegular(path.join(renderOutput, "manifest.json"), "renderer manifest")),
  });
  const root = writeChecksums(output);
  const artifactName = `auditable-demo-media-${sourceSha.slice(0, 12)}-${root.slice(7, 23)}`;
  appendOutputs(values["--github-output"], {
    "media-root": root,
    "media-artifact-name": artifactName,
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
