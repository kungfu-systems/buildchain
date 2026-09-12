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
    },
    outDir: output,
    format: ["cjs"],
    target: "node24",
    platform: "node",
    splitting: false,
    sourcemap: false,
    minify: false,
    clean: false,
    outExtension: () => ({ js: ".cjs" }),
    silent: true,
  });
  if (
    check &&
    !fs
      .readFileSync(path.join(output, "release-discussion.cjs"))
      .equals(fs.readFileSync("dist/readers/release-discussion.cjs"))
  )
    throw new Error("Historical release reader bundle is stale");
} finally {
  if (check) fs.rmSync(output, { recursive: true, force: true });
}
