#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { preparePublicationNpmPackage } from "../packages/core/publication-package.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

export function runPublicationPackageCli(args = process.argv.slice(2)) {
  const result = preparePublicationNpmPackage({
    cwd: readFlag(args, "cwd", process.cwd()),
    outputDir: readFlag(args, "output-dir", ".buildchain/publication/npm-package"),
    packageName: readFlag(args, "package-name", ""),
  });
  if (readBooleanFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`publication-package-dir=${result.outputDir}\n`);
    process.stdout.write(`publication-package-name=${result.package.name}\n`);
    process.stdout.write(`publication-package-version=${result.package.version}\n`);
    process.stdout.write(`publication-package-dist-tag=${result.package.distTag}\n`);
  }
  return result;
}

if (!process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPublicationPackageCli();
  } catch (error) {
    console.error(`publication-package: ${error.message}`);
    process.exitCode = 1;
  }
}
