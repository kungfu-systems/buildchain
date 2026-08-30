#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveV4ReleaseCandidateAdapter({
  resumeCandidateRunId = "",
} = {}) {
  const mode = String(resumeCandidateRunId || "").trim() ? "recovery" : "fresh";
  return Object.freeze({
    mode,
    script:
      mode === "recovery"
        ? "scripts/resume-from-candidate-run.mjs"
        : "scripts/release-candidate-resolver.mjs",
  });
}

export function runV4ReleaseCandidateAdapter({
  env = process.env,
  exec = execFileSync,
} = {}) {
  const route = resolveV4ReleaseCandidateAdapter({
    resumeCandidateRunId: env.BUILDCHAIN_RESUME_CANDIDATE_RUN_ID,
  });
  exec(process.execPath, [path.join(root, route.script)], {
    env,
    stdio: "inherit",
  });
  return route;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runV4ReleaseCandidateAdapter();
}
