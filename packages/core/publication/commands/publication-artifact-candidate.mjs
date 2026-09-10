#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPublicationArtifactCandidate } from "../candidate/artifact.js";
function flag(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(process.argv[index + 1] || "");
}

function requiredFlag(name) {
  const value = flag(name).trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function main() {
  const result = buildPublicationArtifactCandidate({
    artifactRoot: requiredFlag("artifact-root"),
    controllerRoot: requiredFlag("controller-root"),
    repository: requiredFlag("repository"),
    sourceSha: requiredFlag("source-sha"),
    sourceTreeSha: requiredFlag("source-tree-sha"),
    runtimeSha: requiredFlag("runtime-sha"),
  });
  const output = flag("output");
  if (output) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(
      path.resolve(output),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  if (process.argv.includes("--json") || !output)
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`publication artifact candidate: ${error.message}`);
    process.exitCode = 1;
  }
}
