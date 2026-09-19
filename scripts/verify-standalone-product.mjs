import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  platformTriple,
  packageVersion,
  sourceSha,
} from "../packages/core/build/standalone/identity.js";

const cwd = process.cwd();
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(cwd, "dist/binary", `buildchain-${platformTriple()}.json`),
    "utf8",
  ),
);
const version = packageVersion(cwd);
assert.equal(manifest.version, version);
assert.equal(manifest.sourceSha, sourceSha(cwd));
assert.equal(manifest.platform, platformTriple());
const binary = path.join(
  cwd,
  "dist/binary",
  process.platform === "win32" ? "buildchain.exe" : "buildchain",
);
assert.equal(
  createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  manifest.sha256,
);
assert.equal(
  execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
  version,
);
assert.match(
  execFileSync(binary, ["help"], { encoding: "utf8" }),
  /^Usage:\s+buildchain --help/mu,
);
process.stdout.write(
  `Verified standalone product ${platformTriple()} at ${version}\n`,
);
