import {
  invariant,
  stableJson,
  sha256,
  readRegular,
  decodeUtf8,
  readJson,
  writeJson,
  resolveInside,
  ensureEmptyDirectory,
  listFiles,
  required,
} from "./io.js";
import {
  REQUIRED_ADAPTER_FILES,
  OPTIONAL_ADAPTER_FILES,
  validateScene,
  validateProjection,
  RENDITION_VALIDATION_HELPERS,
  validateSourceCoordinate,
} from "./schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateRenditionSet } from "./renditions.js";
import { validateTerminalCapture } from "./renditions.js";

export function validateAdapterOutput(output, strict = true) {
  for (const name of REQUIRED_ADAPTER_FILES)
    readRegular(
      path.join(output, name),
      `adapter output ${name}`,
      4 * 1024 * 1024,
    );
  const transcript = decodeUtf8(
    readRegular(
      path.join(output, "complete-transcript.txt"),
      "complete transcript",
      4 * 1024 * 1024,
    ),
    "complete transcript",
  ).replace(/\r\n/g, "\n");
  invariant(
    transcript.trim().length > 0,
    "complete transcript must not be empty",
  );
  const lines = transcript.endsWith("\n")
    ? transcript.slice(0, -1).split("\n")
    : transcript.split("\n");
  invariant(lines.length <= 20000, "complete transcript exceeds 20000 lines");
  const scene = validateScene(
    readJson(path.join(output, "scene.json"), "scene"),
  );
  const projection = validateProjection(
    readJson(path.join(output, "public-projection.json"), "projection"),
    scene,
    lines.length,
  );
  const terminalCapturePath = path.join(output, "terminal-capture.json");
  const terminalCapture = fs.existsSync(terminalCapturePath)
    ? validateTerminalCapture(
        readJson(terminalCapturePath, "terminal capture"),
        scene,
        RENDITION_VALIDATION_HELPERS,
      )
    : null;
  const renditionSet = validateRenditionSet(
    output,
    RENDITION_VALIDATION_HELPERS,
  );
  invariant(
    !renditionSet || terminalCapture,
    "rendition set requires the primary terminal capture",
  );
  if (strict) {
    const allowed = new Set([
      ...REQUIRED_ADAPTER_FILES,
      ...OPTIONAL_ADAPTER_FILES,
    ]);
    for (const member of listFiles(output))
      invariant(allowed.has(member), `undeclared adapter output: ${member}`);
  }
  return {
    transcript: transcript.endsWith("\n") ? transcript : `${transcript}\n`,
    lines,
    scene,
    projection,
    terminalCapture,
    renditionSet,
  };
}

export function parseAdapterArguments(value = "[]") {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invariant(false, "adapter arguments must be valid JSON");
  }
  invariant(
    Array.isArray(parsed) && parsed.length <= 32,
    "adapter arguments must be an array with at most 32 entries",
  );
  const reserved = new Set([
    "--artifact-root",
    "--output",
    "--source-coordinate",
  ]);
  for (const [index, argument] of parsed.entries()) {
    invariant(
      typeof argument === "string" &&
        argument.length > 0 &&
        argument.length <= 256 &&
        !/[\0\r\n]/.test(argument),
      `adapter argument ${index} is invalid`,
    );
    invariant(
      !reserved.has(argument),
      `adapter argument ${index} attempts to override a reserved coordinate`,
    );
  }
  return parsed;
}

export function runAdapter(request) {
  const sourceRoot = path.resolve(required(request, "sourceRoot"));
  const artifactRoot = path.resolve(required(request, "artifactRoot"));
  const output = path.resolve(required(request, "output"));
  const diagnostics = path.resolve(required(request, "diagnostics"));
  const sourceCoordinate = path.resolve(required(request, "sourceCoordinate"));
  const adapterRelative = required(request, "adapter");
  const adapterArguments = parseAdapterArguments(
    request["adapterArgumentsJson"] || "[]",
  );
  const adapter = resolveInside(sourceRoot, adapterRelative, "adapter path");
  const metadata = fs.lstatSync(adapter);
  invariant(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "adapter must be a regular non-symlink file",
  );
  invariant((metadata.mode & 0o111) !== 0, "adapter must be executable");
  invariant(
    fs
      .realpathSync(adapter)
      .startsWith(`${fs.realpathSync(sourceRoot)}${path.sep}`),
    "adapter resolves outside source",
  );
  validateSourceCoordinate(
    readJson(sourceCoordinate, "source artifact coordinate"),
  );
  ensureEmptyDirectory(output, "adapter output");
  fs.mkdirSync(diagnostics, { recursive: true });
  const disposableHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-auditable-demo-home-"),
  );
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
      [
        "--artifact-root",
        artifactRoot,
        "--output",
        output,
        "--source-coordinate",
        sourceCoordinate,
        ...adapterArguments,
      ],
      {
        cwd: sourceRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(diagnostics, "adapter.stdout.log"),
      result.stdout || "",
    );
    fs.writeFileSync(
      path.join(diagnostics, "adapter.stderr.log"),
      result.stderr || result.error?.message || "",
    );
    invariant(
      !result.error && result.status === 0,
      `adapter failed with exit code ${result.status ?? "spawn-error"}`,
    );
    const normalized = validateAdapterOutput(output);
    fs.writeFileSync(
      path.join(output, "complete-transcript.txt"),
      normalized.transcript,
    );
    writeJson(path.join(output, "scene.json"), normalized.scene);
    writeJson(
      path.join(output, "public-projection.json"),
      normalized.projection,
    );
    if (normalized.terminalCapture) {
      writeJson(
        path.join(output, "terminal-capture.json"),
        normalized.terminalCapture,
      );
    }
    writeJson(path.join(diagnostics, "adapter.json"), {
      schema: "buildchain.auditable-demo-adapter-execution/v1",
      path: adapterRelative,
      sha256: sha256(readRegular(adapter, "adapter", 4 * 1024 * 1024)),
      arguments: adapterArguments,
      argumentsRoot: sha256(Buffer.from(stableJson(adapterArguments))),
      exitCode: 0,
    });
  } finally {
    fs.rmSync(disposableHome, { recursive: true, force: true });
  }
}

export function prepareSmoke(request) {
  const adapterOutput = path.resolve(required(request, "adapterOutput"));
  const output = path.resolve(required(request, "output"));
  const normalized = validateAdapterOutput(adapterOutput);
  ensureEmptyDirectory(output, "smoke input");
  const firstCue = normalized.projection.cues[0];
  const identifier = `${normalized.scene.id.slice(0, 52)}.gate-smoke`.slice(
    0,
    64,
  );
  const scene = {
    schema: "build-images.demo-scene/v1",
    id: identifier,
    width: 1280,
    height: 720,
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
    cues: [
      {
        startMs: 0,
        endMs: 1000,
        transcriptLines: firstCue.transcriptLines.slice(0, 8),
        annotation: "bounded renderer compatibility smoke",
      },
    ],
  };
  fs.writeFileSync(
    path.join(output, "complete-transcript.txt"),
    normalized.transcript,
  );
  writeJson(path.join(output, "scene.json"), scene);
  writeJson(path.join(output, "public-projection.json"), projection);
}
