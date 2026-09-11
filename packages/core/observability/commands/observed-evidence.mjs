#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { publishObservedEvidence } from "../evidence/publication.js";
function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const output = arg("output");
    const result = publishObservedEvidence({
      manifestPath: arg("manifest"),
      artifactRoot: arg("artifact-root", path.dirname(arg("manifest"))),
      bucket: arg("bucket"),
      distributionId: arg("distribution-id"),
      dryRun: arg("execute", "false") !== "true",
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, json); }
    else process.stdout.write(json);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
