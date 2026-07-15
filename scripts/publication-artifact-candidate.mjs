#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createPublicationArtifactCandidate,
  resolvePublicationCandidateFile,
} from "../packages/core/publication-artifact-candidate.js";

export { resolvePublicationCandidateFile };

function flag(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : String(process.argv[index + 1] || "");
}

function requiredFlag(name) {
  const value = flag(name).trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function filesNamed(root, name) {
  const matches = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name === name) matches.push(full);
    }
  }
  return matches.sort();
}

function oneJson(root, name) {
  const matches = filesNamed(root, name);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${name} under ${root}, found ${matches.length}`,
    );
  return JSON.parse(fs.readFileSync(matches[0], "utf8"));
}

function collectFiles(root) {
  const absoluteRoot = path.resolve(root);
  const files = [];
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(absoluteRoot, full).split(path.sep).join("/"),
          size: fs.statSync(full).size,
          sha256: crypto
            .createHash("sha256")
            .update(fs.readFileSync(full))
            .digest("hex"),
        });
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function buildPublicationArtifactCandidate({
  artifactRoot,
  controllerRoot,
  repository,
  sourceSha,
  sourceTreeSha,
  runtimeSha,
} = {}) {
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedControllerRoot = path.resolve(controllerRoot);
  const evidence = {
    repository,
    sourceSha,
    sourceTreeSha,
    runtimeSha,
    manifest: oneJson(resolvedArtifactRoot, "publication-artifact.json"),
    passport: oneJson(
      resolvedArtifactRoot,
      "publication-artifact-passport.json",
    ),
    controllerReceipt: oneJson(resolvedControllerRoot, "receipt.json"),
    files: collectFiles(resolvedArtifactRoot),
  };
  const candidate = createPublicationArtifactCandidate(evidence);
  return { schemaVersion: 1, candidate, evidence };
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
