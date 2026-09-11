import fs from "node:fs";
import path from "node:path";
import { runAdapter, prepareSmoke } from "./adapter.js";
import { finalizeGate, verifyGate } from "./gate.js";
import { finalizeMedia } from "./media-bundle.js";
import { runDemoContainer } from "./container.js";
export function qualifyDemoAdapter(request, ports = {}) {
  const file = (relative) => path.join(request.workspace, relative);
  (ports.runAdapter || runAdapter)({
    sourceRoot: file("source"),
    artifactRoot: file("source-artifact"),
    sourceCoordinate: file("gate-work/source-artifact.json"),
    adapter: request.adapterPath,
    adapterArgumentsJson: request.adapterArgumentsJson,
    output: file("gate-work/adapter-output"),
    diagnostics: file("gate-diagnostics"),
  });
  (ports.prepareSmoke || prepareSmoke)({
    adapterOutput: file("gate-work/adapter-output"),
    output: file("gate-work/smoke-input"),
  });
  const container = ports.runContainer || runDemoContainer;
  container(request, "smoke");
  if (request.mediaProfile !== "archive-v1")
    container(request, "inspect-smoke");
  const inspection = file("gate-work/smoke-inspection/media-inspection.json");
  return (ports.finalizeGate || finalizeGate)({
    adapterOutput: file("gate-work/adapter-output"),
    smokeInput: file("gate-work/smoke-input"),
    smokeOutput: file("gate-work/smoke-render"),
    sourceCoordinate: file("gate-work/source-artifact.json"),
    diagnostics: file("gate-diagnostics"),
    adapter: request.adapterPath,
    rendererImage: request.rendererImage,
    sourceSha: request.sourceSha,
    mediaProfile: request.mediaProfile,
    ...(fs.existsSync(inspection) ? { mediaInspection: inspection } : {}),
    output: file("gate-bundle"),
  });
}
export function renderQualifiedDemo(request, ports = {}) {
  const file = (relative) => path.join(request.workspace, relative);
  fs.mkdirSync(file("render-diagnostics"), { recursive: true });
  (ports.verifyGate || verifyGate)({
    bundle: file("gate-bundle"),
    expectedRoot: request.gateRoot,
    rendererImage: request.rendererImage,
    sourceSha: request.sourceSha,
    mediaProfile: request.mediaProfile,
  });
  const container = ports.runContainer || runDemoContainer;
  container(request, "render");
  if (request.mediaProfile !== "archive-v1")
    container(request, "inspect-render");
  const inspection = file("render-inspection/media-inspection.json");
  return (ports.finalizeMedia || finalizeMedia)({
    gateBundle: file("gate-bundle"),
    gateRoot: request.gateRoot,
    renderOutput: file("render-work"),
    rendererImage: request.rendererImage,
    sourceSha: request.sourceSha,
    mediaProfile: request.mediaProfile,
    ...(fs.existsSync(inspection) ? { mediaInspection: inspection } : {}),
    output: file("media-bundle"),
  });
}
