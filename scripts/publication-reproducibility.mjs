#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { verifyPublicationReproducibility } from "../packages/core/publication-reproducibility.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

export function runPublicationReproducibilityCli(args = process.argv.slice(2)) {
  const result = verifyPublicationReproducibility({
    cwd: readFlag(args, "cwd", process.cwd()),
    sourceSha: readFlag(args, "source-sha", ""),
    output: readFlag(
      args,
      "output",
      ".buildchain/publication/reproducibility-receipt.json",
    ),
    promote: hasFlag(args, "promote"),
    keepWorkspaces: hasFlag(args, "keep-workspaces"),
    pullToolchain: !hasFlag(args, "no-toolchain-pull"),
    packageName: readFlag(args, "package-name", ""),
    allowUnpinnedToolchain: hasFlag(args, "allow-unpinned-toolchain"),
  });
  if (hasFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `publication-reproducibility=${result.status}`,
        `publication-reproducibility-qualifying=${result.qualifying}`,
        `publication-reproducibility-receipt=${result.outputPath}`,
        `publication-reproducibility-digest=${result.receiptDigest}`,
        "",
      ].join("\n"),
    );
  }
  if (!result.qualifying && !hasFlag(args, "allow-unpinned-toolchain")) {
    process.exitCode = 1;
  } else if (result.status !== "passed") {
    process.exitCode = 1;
  }
  return result;
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runPublicationReproducibilityCli();
  } catch (error) {
    console.error(`publication-reproducibility: ${error.message}`);
    process.exitCode = 1;
  }
}
