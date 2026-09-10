#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareArtifact, validateScenario } from "../demo/scenario.js";
import { adaptCapture } from "../demo/capture.js";
import { materializeDemo } from "../demo/materialization.js";
import { readJson, stableJson, rootJson, fail, requireValue } from "../demo/values.js";
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    requireValue(key?.startsWith("--") && value !== undefined && !(key in values), `invalid argument near ${key || "<empty>"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "validate") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(stableJson({ ok: true, scenarioRoot: rootJson(scenario), demoIds: scenario.demos.map((entry) => entry.id) }));
    return;
  }
  if (command === "list") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(`${scenario.demos.map((entry) => entry.id).join("\n")}\n`);
    return;
  }
  if (command === "publication") {
    const scenario = validateScenario(readJson(path.resolve(args.scenario), "scenario"));
    process.stdout.write(stableJson({
      ...scenario.publication,
      ...(scenario.presentation ? { technicalSpecPath: scenario.presentation.materialization.technicalSpecPath } : {}),
    }));
    return;
  }
  if (command === "prepare-artifact") {
    const result = prepareArtifact({
      artifactRoot: path.resolve(args["artifact-root"]),
      scenarioPath: path.resolve(args.scenario),
    });
    process.stdout.write(stableJson({ ok: true, ...result }));
    return;
  }
  if (command === "adapt") {
    const result = adaptCapture({ artifactRoot: path.resolve(args["artifact-root"]), output: path.resolve(args.output) });
    process.stdout.write(stableJson({ ok: true, ...result }));
    return;
  }
  if (command === "materialize") {
    const result = materializeDemo({
      repositoryRoot: path.resolve(args.repository),
      scenarioPath: path.resolve(args.scenario),
      demoId: args["demo-id"],
      captureRoot: path.resolve(args.capture),
      gateBundle: path.resolve(args.gate),
      mediaBundle: path.resolve(args.media),
      buildchainSha: args["buildchain-sha"],
      rendererImage: args["renderer-image"],
    });
    process.stdout.write(stableJson(result));
    return;
  }
  fail(`unknown command: ${command || "<empty>"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
