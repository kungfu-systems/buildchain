#!/usr/bin/env node
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runLifecycle } from "./run-lifecycle-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function parseList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function runLifecycleCli() {
  return runLifecycle({
    cwd: readArg("cwd", process.cwd()),
    stageName: readArg("stage"),
    command: process.env.BUILDCHAIN_COMMAND || "",
    required: readArg("required", "false") === "true",
    manifestPath: readArg("manifest-path", ".buildchain/artifacts/manifest.json"),
    artifactName: readArg("artifact-name", "buildchain-artifact"),
    platformId: readArg("platform-id", os.platform()),
    platformName: readArg("platform-name", readArg("platform-id", os.platform())),
    artifactPaths: parseList(process.env.BUILDCHAIN_ARTIFACT_PATHS || ""),
    workspace: process.cwd(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLifecycleCli();
}
