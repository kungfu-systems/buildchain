import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_FACTS_LEGACY_KUNGFU_BUILDINFO_CONTRACT,
  BUILD_FACTS_MODULE_CONTRACT,
  BUILD_FACTS_PRODUCT_CONTRACT,
  aggregateBuildFacts,
  collectModuleBuildFacts,
  verifyBuildFacts,
  writeBuildFacts,
} from "@kungfu-tech/buildchain/build-facts";
import { validateBuildchainConfig } from "@kungfu-tech/buildchain";
import { collectGitHubReleasePassport } from "@kungfu-tech/buildchain/release-passport";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function writeFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
  return filePath;
}

function runGit(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function createBuildFactsFixture() {
  const cwd = tempDir("build-facts");
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "buildchain-test@example.invalid"]);
  runGit(cwd, ["config", "user.name", "Buildchain Test"]);
  writeFile(path.join(cwd, "package.json"), `${JSON.stringify({ name: "@kungfu-tech/kungfu", version: "4.0.0-alpha.1" }, null, 2)}\n`);
  writeFile(path.join(cwd, "src/core/main.cc"), "int kungfu_core(void) { return 1; }\n");
  writeFile(path.join(cwd, "dist/core.node"), "native payload\n");
  writeFile(path.join(cwd, "dist/kungfu.zip"), "product archive\n");
  writeFile(path.join(cwd, "dist/tree/a.txt"), "a\n");
  writeFile(path.join(cwd, "dist/tree/nested/b.txt"), "b\n");
  writeFile(path.join(cwd, "buildchain.toml"), `schema = 1

[[facts.version_sources]]
id = "package"
type = "json"
path = "package.json"
key = "version"

[[facts.modules]]
id = "core"
root = "src/core"
scope = "native-core"
version_source = "package"
lifecycle = "build"
outputs = ["dist/core.node", "dist/tree"]

[[facts.products]]
id = "kungfu"
module_facts = [".buildchain/facts/core.json"]
artifacts = ["dist/kungfu.zip"]

[[facts.legacy_projections]]
type = "kungfu-buildinfo"
module = "core"
path = "framework/core/src/kungfu/yijinjing/kungfubuildinfo.json"
`);
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "fixture"]);
  return cwd;
}

function runBuildchain(args, options = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, result.stdout || result.stderr);
  } else {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return result;
}

test("Build Facts Node API collects module facts, product facts, and stale source detection", () => {
  const cwd = createBuildFactsFixture();
  const normalized = validateBuildchainConfig(cwd);
  assert.equal(normalized.facts.modules[0].id, "core");

  const moduleFact = collectModuleBuildFacts({ cwd, moduleId: "core", now: "2026-07-08T00:00:00.000Z" });
  assert.equal(moduleFact.contract, BUILD_FACTS_MODULE_CONTRACT);
  assert.equal(moduleFact.id, "core");
  assert.equal(moduleFact.scope, "native-core");
  assert.equal(moduleFact.version.value, "4.0.0-alpha.1");
  assert.equal(moduleFact.platform, `${process.platform}-${process.arch}`);
  assert.equal(moduleFact.outputs.length, 2);
  assert.equal(moduleFact.outputs[1].kind, "directory");
  assert.match(moduleFact.outputs[1].digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(moduleFact.verification.ok, true, JSON.stringify(moduleFact.verification.issues, null, 2));

  const moduleWrite = writeBuildFacts({ cwd, fact: moduleFact, output: ".buildchain/facts/core.json" });
  assert.match(moduleWrite.digest, /^sha256:[a-f0-9]{64}$/);

  const productFact = aggregateBuildFacts({ cwd, productId: "kungfu", now: "2026-07-08T00:00:00.000Z" });
  assert.equal(productFact.contract, BUILD_FACTS_PRODUCT_CONTRACT);
  assert.equal(productFact.id, "kungfu");
  assert.equal(productFact.modules[0].id, "core");
  assert.equal(productFact.modules[0].verificationStatus, "passed");
  assert.equal(productFact.verification.ok, true, JSON.stringify(productFact.verification.issues, null, 2));

  writeFile(path.join(cwd, "src/core/main.cc"), "int kungfu_core(void) { return 2; }\n");
  const stale = verifyBuildFacts({ cwd, fact: moduleFact });
  assert.equal(stale.ok, false);
  assert.equal(stale.issues.some((issue) => issue.id === "git.sourceDigest"), true);
});

test("Build Facts CLI writes module facts, legacy Kungfu buildinfo, product facts, and verifies them", () => {
  const cwd = createBuildFactsFixture();
  const moduleResult = runBuildchain([
    "facts",
    "module",
    "--cwd",
    cwd,
    "--module",
    "core",
    "--output",
    ".buildchain/facts/core.json",
    "--legacy-kungfu-buildinfo",
    "framework/core/src/kungfu/yijinjing/kungfubuildinfo.json",
    "--json",
  ]);
  const moduleOutput = JSON.parse(moduleResult.stdout);
  assert.equal(moduleOutput.contract, BUILD_FACTS_MODULE_CONTRACT);
  assert.equal(moduleOutput.verification.ok, true, JSON.stringify(moduleOutput.verification.issues, null, 2));

  const legacy = JSON.parse(fs.readFileSync(path.join(cwd, "framework/core/src/kungfu/yijinjing/kungfubuildinfo.json"), "utf8"));
  assert.equal(legacy.contract, BUILD_FACTS_LEGACY_KUNGFU_BUILDINFO_CONTRACT);
  assert.equal(legacy.version, "4.0.0-alpha.1");
  assert.equal(legacy.source.moduleId, "core");
  assert.match(legacy.buildchain.moduleFactDigest, /^sha256:[a-f0-9]{64}$/);

  const aggregateResult = runBuildchain([
    "facts",
    "aggregate",
    "--cwd",
    cwd,
    "--product",
    "kungfu",
    "--module-fact",
    ".buildchain/facts/core.json",
    "--artifact",
    "dist/kungfu.zip",
    "--output",
    ".buildchain/facts/kungfu.json",
    "--json",
  ]);
  const aggregateOutput = JSON.parse(aggregateResult.stdout);
  assert.equal(aggregateOutput.contract, BUILD_FACTS_PRODUCT_CONTRACT);
  assert.equal(aggregateOutput.verification.ok, true, JSON.stringify(aggregateOutput.verification.issues, null, 2));

  const verifyResult = runBuildchain(["facts", "verify", "--cwd", cwd, "--fact", ".buildchain/facts/kungfu.json", "--json"]);
  const verification = JSON.parse(verifyResult.stdout);
  assert.equal(verification.ok, true, JSON.stringify(verification.issues, null, 2));
});

test("Release Passport records build facts as first-class evidence", () => {
  const cwd = createBuildFactsFixture();
  const moduleFact = collectModuleBuildFacts({ cwd, moduleId: "core", now: "2026-07-08T00:00:00.000Z" });
  const { path: moduleFactPath } = writeBuildFacts({ cwd, fact: moduleFact, output: ".buildchain/facts/core.json" });

  const collection = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.1",
    repository: "kungfu-systems/kungfu",
    sourceSha: "a".repeat(40),
    outputDir: ".buildchain/release-passport",
    assetsDir: "dist",
    productName: "Kungfu",
    packageName: "@kungfu-tech/kungfu",
    packageVersion: "4.0.0-alpha.1",
    buildFactsJsons: [moduleFactPath],
  });

  assert.equal(collection.passport.buildFacts.length, 1);
  assert.equal(collection.passport.buildFacts[0].fields.contract, BUILD_FACTS_MODULE_CONTRACT);
  assert.equal(collection.passport.evidence.buildFacts[0].contract, BUILD_FACTS_MODULE_CONTRACT);
  assert.equal(collection.passport.evidence.buildFacts[0].id, "core");
});
