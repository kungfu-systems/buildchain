#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runTransportSmoke } from "../demo/transport-smoke.js";
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2)
    values[argv[index].replace(/^--/u, "")] = argv[index + 1];
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(
      `${JSON.stringify({ ok: true, ...runTransportSmoke({ artifactRoot: args["artifact-root"], scenarioPath: args.scenario }) }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
