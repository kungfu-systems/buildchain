import { build } from "tsup";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const check = process.argv.includes("--check");
const output = check
  ? fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-reader-check-"))
  : "dist/readers";
try {
  await build({
    entry: {
      "release-discussion": "packages/core/release/discussion/reader-entry.js",
      "business-attempt": "packages/core/workflow/attempt/reader-entry.js",
    },
    outDir: output,
    format: ["cjs"],
    target: "node24",
    platform: "node",
    splitting: false,
    noExternal: ["smol-toml"],
    sourcemap: false,
    minify: false,
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
    silent: true,
  });
  if (check)
    for (const name of ["release-discussion", "business-attempt"]) {
      if (
        !fs
          .readFileSync(path.join(output, `${name}.cjs`))
          .equals(fs.readFileSync(`dist/readers/${name}.cjs`))
      )
        throw new Error(`Historical ${name} reader bundle is stale`);
    }
} finally {
  if (check) fs.rmSync(output, { recursive: true, force: true });
}
