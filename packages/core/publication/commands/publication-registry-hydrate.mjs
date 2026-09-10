#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { hydratePublishedPublicationRegistry } from "../candidate/registry-hydration.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const cwdIndex = process.argv.indexOf("--cwd");
    const result = hydratePublishedPublicationRegistry({
      cwd: cwdIndex === -1 ? process.cwd() : process.argv[cwdIndex + 1],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`publication-registry-hydrate: ${error.message}`);
    process.exitCode = 1;
  }
}
