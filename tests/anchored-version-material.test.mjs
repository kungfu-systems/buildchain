import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHORED_VERSION_MATERIAL_CONTRACT,
  createAnchoredVersionMaterialEvidence,
} from "../packages/core/anchored-version-material.js";

function run(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeJson(cwd, filePath, value) {
  const absolutePath = path.join(cwd, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-anchored-material-"));
  fs.mkdirSync(path.join(cwd, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"
derived_files = [
  ".buildchain/kfd-1/example-contract-world.witness.json",
  ".buildchain/kfd-3/collaboration-interface.prebuild.json",
]

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.version-state]
command = "node scripts/derive.mjs"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`);
  fs.writeFileSync(path.join(cwd, "scripts/derive.mjs"), `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.mkdirSync(".buildchain/kfd-1", { recursive: true });
fs.mkdirSync(".buildchain/kfd-3", { recursive: true });
fs.writeFileSync(
  ".buildchain/kfd-1/example-contract-world.witness.json",
  JSON.stringify({ contractWorldVersion: pkg.version }, null, 2) + "\\n",
);
fs.writeFileSync(
  ".buildchain/kfd-3/collaboration-interface.prebuild.json",
  JSON.stringify({ collaborationVersion: pkg.version }, null, 2) + "\\n",
);
`);
  fs.writeFileSync(path.join(cwd, "scripts/verify.mjs"), `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const release = JSON.parse(fs.readFileSync("release.json", "utf8"));
const contractWorld = JSON.parse(fs.readFileSync(
  ".buildchain/kfd-1/example-contract-world.witness.json",
  "utf8",
));
const collaboration = JSON.parse(fs.readFileSync(
  ".buildchain/kfd-3/collaboration-interface.prebuild.json",
  "utf8",
));
assert.equal(release.npmVersion, pkg.version);
assert.equal(contractWorld.contractWorldVersion, pkg.version);
assert.equal(collaboration.collaborationVersion, pkg.version);
`);
  writeJson(cwd, "package.json", { name: "@kungfu-tech/example", version: "1.0.0-alpha.0" });
  writeJson(cwd, "release.json", { npmVersion: "1.0.0-alpha.0" });
  writeJson(cwd, ".buildchain/kfd-1/example-contract-world.witness.json", {
    contractWorldVersion: "1.0.0-alpha.0",
  });
  writeJson(cwd, ".buildchain/kfd-3/collaboration-interface.prebuild.json", {
    collaborationVersion: "1.0.0-alpha.0",
  });
  run(cwd, ["init"]);
  run(cwd, ["config", "user.name", "Test"]);
  run(cwd, ["config", "user.email", "test@example.com"]);
  run(cwd, ["add", "."]);
  run(cwd, ["commit", "-m", "test: alpha"]);
  run(cwd, ["tag", "v1.0.0-alpha.0"]);
  writeJson(cwd, "package.json", { name: "@kungfu-tech/example", version: "1.0.0" });
  writeJson(cwd, "release.json", { npmVersion: "1.0.0" });
  writeJson(cwd, ".buildchain/kfd-1/example-contract-world.witness.json", {
    contractWorldVersion: "1.0.0",
  });
  writeJson(cwd, ".buildchain/kfd-3/collaboration-interface.prebuild.json", {
    collaborationVersion: "1.0.0",
  });
  run(cwd, ["add", "."]);
  run(cwd, ["commit", "-m", "test: release"]);
  return cwd;
}

test("anchored release material binds declared paths, digests, and exact trees", () => {
  const cwd = createFixture();
  try {
    const evidence = createAnchoredVersionMaterialEvidence({
      cwd,
      targetChannel: "release",
      targetRef: "release/v1/v1.0",
    });
    assert.equal(evidence.contract, ANCHORED_VERSION_MATERIAL_CONTRACT);
    assert.equal(evidence.applicable, true);
    assert.deepEqual(evidence.changedPaths, [
      ".buildchain/kfd-1/example-contract-world.witness.json",
      ".buildchain/kfd-3/collaboration-interface.prebuild.json",
      "package.json",
      "release.json",
    ]);
    assert.deepEqual(evidence.derivedPaths, [
      ".buildchain/kfd-1/example-contract-world.witness.json",
      ".buildchain/kfd-3/collaboration-interface.prebuild.json",
    ]);
    assert.match(
      evidence.release.material.find(
        (entry) =>
          entry.path ===
          ".buildchain/kfd-1/example-contract-world.witness.json",
      ).sha256,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("anchored release material fails closed for undeclared tree changes", () => {
  const cwd = createFixture();
  try {
    fs.writeFileSync(path.join(cwd, "runtime.cc"), "int main() { return 0; }\n");
    run(cwd, ["add", "runtime.cc"]);
    run(cwd, ["commit", "-m", "test: undeclared code"]);
    assert.throws(
      () => createAnchoredVersionMaterialEvidence({
        cwd,
        targetChannel: "release",
        targetRef: "release/v1/v1.0",
      }),
      /changed undeclared paths: runtime\.cc/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("anchored release material fails before heavy work when derivation changes a stale witness", () => {
  const cwd = createFixture();
  try {
    writeJson(cwd, ".buildchain/kfd-1/example-contract-world.witness.json", {
      contractWorldVersion: "stale",
    });
    run(cwd, ["add", ".buildchain/kfd-1/example-contract-world.witness.json"]);
    run(cwd, ["commit", "-m", "test: stale witness"]);
    assert.throws(
      () => createAnchoredVersionMaterialEvidence({
        cwd,
        targetChannel: "release",
        targetRef: "release/v1/v1.0",
      }),
      /stale or hand-edited/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
