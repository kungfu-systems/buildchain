#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";

function normalize(value, name) {
  const normalized = String(value ?? "").trim();
  if (/\r|\n|\0/.test(normalized)) {
    throw new Error(`${name} must be a single-line NO_PROXY value`);
  }
  return normalized;
}

export function resolveArtifactSigningUploadRoute({
  requestedNoProxy = "",
  noProxy = "",
  lowerNoProxy = "",
} = {}) {
  const requested = normalize(requestedNoProxy, "artifact signing request upload NO_PROXY");
  const currentUpper = normalize(noProxy, "NO_PROXY");
  const currentLower = normalize(lowerNoProxy, "no_proxy");

  return {
    noProxy: requested || currentUpper || currentLower,
    overrideApplied: requested !== "",
  };
}

export function writeGitHubOutputs(route, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `no-proxy=${route.noProxy}`,
      `override-applied=${route.overrideApplied}`,
      "",
    ].join("\n"),
  );
}

function main() {
  const route = resolveArtifactSigningUploadRoute({
    requestedNoProxy: process.env.BUILDCHAIN_SIGNING_REQUEST_UPLOAD_NO_PROXY,
    noProxy: process.env.NO_PROXY,
    lowerNoProxy: process.env.no_proxy,
  });
  writeGitHubOutputs(route);
  process.stdout.write(
    `Resolved artifact signing request upload route (override=${route.overrideApplied ? "yes" : "no"}).\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
