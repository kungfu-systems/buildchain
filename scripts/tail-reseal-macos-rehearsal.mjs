import { pathToFileURL } from "node:url";
import { rehearseTailResealMacos } from "../packages/core/build/stage-capsule/rehearsal/macos-tail.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : String(args[index + 1] || "");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const evidence = rehearseTailResealMacos({
      fixturePath: flag(
        process.argv.slice(2),
        "fixture",
        "contracts/fixtures/v4-tail-reseal-v1/valid.json",
      ),
      outputPath: flag(process.argv.slice(2), "output"),
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    console.error(`v4-tail-reseal-macos-rehearsal: ${error.message}`);
    process.exitCode = 1;
  }
}
