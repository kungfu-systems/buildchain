#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createReleaseEvidenceBundle, BUNDLE_CONTRACT } from "../../build/release-evidence-bundle.js";
function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = createReleaseEvidenceBundle({
      cwd: path.resolve(readArg("cwd", process.cwd())),
      assetsDir: readArg("assets-dir", "dist/binary"),
      passportDir: readArg("passport-dir", ".buildchain/release-passport"),
      outputDir: readArg("output-dir", ".buildchain/release-passport"),
      tag: readArg("tag", process.env.RELEASE_TAG || ""),
      sourceSha: readArg("source-sha", process.env.GITHUB_SHA || ""),
    });
    process.stdout.write(`${JSON.stringify({
      contract: BUNDLE_CONTRACT,
      archive: result.manifest.bundle,
      fileCount: result.manifest.files.length,
    }, null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain release bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
