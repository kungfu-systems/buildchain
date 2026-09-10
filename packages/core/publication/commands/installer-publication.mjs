#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateInstallerPublication, verifyInstallerPublicReadback } from "../installer/evidence.js";

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--manifest") options.manifest = args[++index];
    else if (value === "--artifact-root") options.artifactRoot = args[++index];
    else if (value === "--public-readback") options.publicReadback = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.manifest) throw new Error("--manifest is required");
  if (!options.publicReadback && !options.artifactRoot) {
    throw new Error("--artifact-root is required without --public-readback");
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  const publication = JSON.parse(
    fs.readFileSync(path.resolve(options.manifest), "utf8"),
  );
  const evidence = options.publicReadback
    ? await verifyInstallerPublicReadback({ publication })
    : validateInstallerPublication({
        publication,
        artifactRoot: path.resolve(options.artifactRoot),
      });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`installer-publication: ${error.message}\n`);
    process.exitCode = 1;
  });
}
