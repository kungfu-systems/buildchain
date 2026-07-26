import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("macOS credential-island fixture requires macOS");
}

const appRoot = path.join(
  process.cwd(),
  "dist",
  "Buildchain Credential Island.app",
);
const plist = path.join(appRoot, "Contents", "Info.plist");
const executable = path.join(
  appRoot,
  "Contents",
  "MacOS",
  "BuildchainCredentialIsland",
);
assert.equal(fs.statSync(appRoot).isDirectory(), true);
assert.equal(fs.statSync(executable).isFile(), true);

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw (
      result.error ||
      new Error(
        `${path.basename(command)} failed with status ${result.status}: ${(result.stderr || result.stdout || "").trim()}`,
      )
    );
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

assert.equal(
  run("/usr/bin/plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    plist,
  ]),
  "dev.libkungfu.buildchain.credential-island",
);
assert.match(run("/usr/bin/file", [executable]), /Mach-O/u);

const signature = spawnSync("/usr/bin/codesign", ["--verify", executable], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
assert.notEqual(
  signature.status,
  0,
  "fixture must remain unsigned until the protected credential island",
);
