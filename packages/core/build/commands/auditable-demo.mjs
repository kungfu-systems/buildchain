#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAdapter, prepareSmoke } from "../demo/adapter.js";
import { finalizeGate, verifyGate } from "../demo/gate.js";
import { finalizeMedia } from "../demo/media-bundle.js";
import { inspectRendererMedia } from "../demo/media-inspection.js";
import { qualifyMediaFixture } from "../demo/renderer-evidence.js";
import { appendOutputs, stableJson, invariant, required } from "../demo/io.js";

function parseArguments(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(key?.startsWith("--") && value !== undefined, `invalid argument near ${key || "<empty>"}`);
    invariant(!(key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase()) in values), `duplicate argument: ${key}`);
    values[key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  return { command, values };
}

function main(argv) {
  const { command, values } = parseArguments(argv);
  switch (command) {
    case "run-adapter":
      return runAdapter(values);
    case "prepare-smoke":
      return prepareSmoke(values);
    case "finalize-gate":
      { const result = finalizeGate(values); appendOutputs(values.githubOutput, { "gate-root": result.root, "gate-artifact-name": result.artifactName }); process.stdout.write(stableJson({ status: result.status, root: result.root, artifactName: result.artifactName })); return result; }
    case "verify-gate":
      return verifyGate(values);
    case "finalize-media":
      { const result = finalizeMedia(values); appendOutputs(values.githubOutput, { "media-root": result.root, "media-artifact-name": result.artifactName, "media-profile": result.mediaProfile, "media-qualification-root": result.mediaQualificationRoot }); process.stdout.write(stableJson({ status: result.status, root: result.root, artifactName: result.artifactName })); return result; }
    case "inspect-media":
      return inspectRendererMedia(values);
    case "qualify-media-fixture":
      return qualifyMediaFixture({
        renderOutput: required(values, "renderOutput"),
        output: required(values, "output"),
        rendererImage: required(values, "rendererImage"),
        rendererSourceRepository: required(values, "rendererSourceRepository"),
        rendererSourceRef: required(values, "rendererSourceRef"),
        rendererSourceSha: required(values, "rendererSourceSha"),
        mediaProfile: required(values, "mediaProfile"),
        mediaInspection: required(values, "mediaInspection"),
      });
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
