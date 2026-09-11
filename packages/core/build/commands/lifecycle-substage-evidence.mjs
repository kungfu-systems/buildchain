#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLifecycleSubstageEvidence } from "../lifecycle/substage-evidence.js";
function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || index + 1 >= argv.length)
      throw new Error(`invalid option: ${flag || "missing"}`);
    options[flag.slice(2)] = argv[index + 1];
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const evidence = readLifecycleSubstageEvidence(options.file, {
    lifecycleStage: options.stage || "",
    sourceSha: options["source-sha"] || "",
    sourceTree: options["source-tree"] || "",
    platformId: options["platform-id"] || "",
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, evidenceRoot: evidence.evidenceRoot, conclusion: evidence.conclusion })}\n`,
  );
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "lifecycle-substage-evidence.mjs" &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[lifecycle-substages] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
