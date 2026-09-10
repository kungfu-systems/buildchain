import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPublicationArtifactCandidate } from "../publication-artifact-candidate.js";
function exactJson(root, relativePath) {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(
      `publication evidence path escapes artifact root: ${relativePath}`,
    );
  }
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`expected publication evidence at ${relativePath}`);
  }
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
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
    manifest: exactJson(
      resolvedArtifactRoot,
      ".buildchain/publication/publication-artifact.json",
    ),
    passport: exactJson(
      resolvedArtifactRoot,
      ".buildchain/publication/publication-artifact-passport.json",
    ),
    controllerReceipt: exactJson(resolvedControllerRoot, "receipt.json"),
    files: collectFiles(resolvedArtifactRoot),
  };
  const candidate = createPublicationArtifactCandidate(evidence);
  return { schemaVersion: 1, candidate, evidence };
}
