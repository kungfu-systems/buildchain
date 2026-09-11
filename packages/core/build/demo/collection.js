import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { command } from "../../runtime/action-process.mjs";
import { prepareArtifact } from "./scenario.js";
import { demoScenario } from "./collection-context.js";
import {
  collectionContainerArguments,
  requireDemoImage,
} from "./collection-containers.js";
import { adaptCapturedDemo, CAPTURE_ADAPTER } from "./capture-adaptation.js";
import { prepareSmoke } from "./adapter.js";
import { finalizeGate } from "./gate.js";
import { finalizeMedia } from "./media-bundle.js";
function writable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(directory, 0o777);
}
export function captureDemoCollection(request, execute = command) {
  requireDemoImage(request.rendererImage);
  const { scenario, scenarioPath } = demoScenario(request);
  prepareArtifact({
    scenarioPath,
    artifactRoot: path.join(request.workspace, "source-artifact"),
  });
  execute("docker", ["pull", request.rendererImage]);
  for (const demo of scenario.demos) {
    writable(path.join(request.workspace, `capture-collection/${demo.id}`));
    execute(
      "docker",
      collectionContainerArguments(request, "capture", demo.id),
    );
  }
}
export function qualifyDemoCollection(request, ports = {}) {
  const execute = ports.execute || command;
  requireDemoImage(request.rendererImage);
  const { scenario } = demoScenario(request);
  execute("docker", ["pull", request.rendererImage]);
  const absolute = (relative) => path.join(request.workspace, relative);
  for (const demo of scenario.demos) {
    const root = `qualified-collection/${demo.id}`;
    fs.mkdirSync(absolute(`${root}/diagnostics`), { recursive: true });
    writable(absolute(`${root}/smoke-output`));
    writable(absolute(`${root}/render-output`));
    (ports.adapt || adaptCapturedDemo)({
      runtimeRoot: request.runtimeRoot,
      artifactRoot: absolute(`capture-collection/${demo.id}/capture`),
      sourceCoordinate: absolute("capture-coordinate.json"),
      output: absolute(`${root}/adapter`),
      diagnostics: absolute(`${root}/diagnostics`),
    });
    (ports.prepare || prepareSmoke)({
      adapterOutput: absolute(`${root}/adapter`),
      output: absolute(`${root}/smoke-input`),
    });
    execute("docker", collectionContainerArguments(request, "smoke", demo.id));
    writable(absolute(`${root}/smoke-inspection`));
    execute(
      "docker",
      collectionContainerArguments(request, "inspect-smoke", demo.id),
    );
    (ports.finalize || finalizeGate)({
      adapterOutput: absolute(`${root}/adapter`),
      smokeInput: absolute(`${root}/smoke-input`),
      smokeOutput: absolute(`${root}/smoke-output`),
      sourceCoordinate: absolute("capture-coordinate.json"),
      diagnostics: absolute(`${root}/diagnostics`),
      adapter: CAPTURE_ADAPTER,
      rendererImage: request.rendererImage,
      sourceSha: request.sourceSha,
      mediaProfile: request.mediaProfile,
      mediaInspection: absolute(
        `${root}/smoke-inspection/media-inspection.json`,
      ),
      output: absolute(`${root}/gate`),
    });
  }
}
export function renderDemoCollection(request, ports = {}) {
  const execute = ports.execute || command;
  requireDemoImage(request.rendererImage);
  const { scenario } = demoScenario(request);
  const absolute = (relative) => path.join(request.workspace, relative);
  for (const demo of scenario.demos) {
    const root = `qualified-collection/${demo.id}`;
    const gateRoot = `sha256:${crypto
      .createHash("sha256")
      .update(fs.readFileSync(absolute(`${root}/gate/checksums.sha256`)))
      .digest("hex")}`;
    execute(
      "docker",
      collectionContainerArguments(request, "validate", demo.id),
    );
    execute("docker", collectionContainerArguments(request, "render", demo.id));
    writable(absolute(`${root}/render-inspection`));
    execute(
      "docker",
      collectionContainerArguments(request, "inspect-render", demo.id),
    );
    (ports.finalize || finalizeMedia)({
      gateBundle: absolute(`${root}/gate`),
      gateRoot,
      renderOutput: absolute(`${root}/render-output`),
      rendererImage: request.rendererImage,
      sourceSha: request.sourceSha,
      mediaProfile: request.mediaProfile,
      mediaInspection: absolute(
        `${root}/render-inspection/media-inspection.json`,
      ),
      output: absolute(`${root}/media`),
    });
  }
}
export function qualifyCapturedDemos(request, ports = {}) {
  (ports.qualify || qualifyDemoCollection)(request);
  let renderOutcome = "skipped";
  if (request.renderMedia) {
    try {
      (ports.render || renderDemoCollection)(request);
      renderOutcome = "success";
    } catch (error) {
      if (!request.renderFailureAdvisory) throw error;
      renderOutcome = "failure";
      ports.onAdvisoryFailure?.(error);
    }
  }
  return { renderOutcome };
}
