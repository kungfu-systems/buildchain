import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkHomebrewTap,
  collectHomebrewTapFacts,
  renderHomebrewFormula,
  updateHomebrewTap,
} from "@kungfu-tech/buildchain/homebrew";
import { normalizeBuildchainConfig } from "@kungfu-tech/buildchain";
import { collectGitHubReleasePassport } from "@kungfu-tech/buildchain/release-passport";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-homebrew-${name}-`));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function createVerifiedReleasePassportFixture() {
  const cwd = tempDir("passport");
  fs.writeFileSync(path.join(cwd, "surface.txt"), "declared Buildchain public surface\n");
  const surfaceSha = sha256File(path.join(cwd, "surface.txt"));
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "dist", "buildchain-aarch64-apple-darwin.tar.gz"), "darwin archive\n");
  fs.writeFileSync(path.join(cwd, "dist", "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "linux archive\n");
  fs.writeFileSync(path.join(cwd, "dist", "buildchain-x86_64-pc-windows-msvc.zip"), "windows archive\n");

  const publicSurface = {
    id: "surface.txt",
    name: "surface.txt",
    kind: "documentation",
    availability: "shipped",
    visibility: "public",
    participantFacing: true,
    public: true,
    sourcePath: "surface.txt",
    evidencePath: "surface.txt",
  };
  const witnessDir = path.join(cwd, ".buildchain", "witnesses");
  const kfd1Path = writeJson(path.join(witnessDir, "kfd-1.json"), {
    schemaVersion: 1,
    id: "buildchain-homebrew-fixture-contract-world",
    standard: "kfd-1",
    surfaces: [
      {
        name: "surface.txt",
        sourcePath: "surface.txt",
        sourceSha256: surfaceSha,
        artifactPath: "surface.txt",
        expectedSha256: surfaceSha,
        byteForByte: true,
      },
    ],
  });
  const kfd3PrebuildPath = writeJson(path.join(witnessDir, "kfd-3-prebuild.json"), {
    schemaVersion: 1,
    id: "buildchain-homebrew-fixture-collaboration-interface",
    standard: "kfd-3",
    supportLevel: "release",
    declaredSurfaces: [publicSurface],
    auditBoundary: {
      mode: "closed-world",
      scope: "fixture public surfaces",
      reachableSurfaceMode: "declared-boundary",
      unclassifiedPolicy: "fail",
    },
    responsibility: {
      registryFactsOwner: "fixture maintainers",
      artifactVerificationOwner: "fixture build",
      releasePassportProofOwner: "buildchain",
    },
  });
  const kfd3ArtifactPath = writeJson(path.join(witnessDir, "kfd-3-artifact.json"), {
    schemaVersion: 1,
    id: "buildchain-homebrew-fixture-collaboration-interface",
    standard: "kfd-3",
    artifact: {
      name: "@kungfu-tech/buildchain",
      path: "surface.txt",
      digest: `sha256:${surfaceSha}`,
    },
    exposedSurfaces: [publicSurface],
    verifier: {
      name: "fixture verifier",
    },
  });
  const collection = collectGitHubReleasePassport({
    cwd,
    tag: "v2.9.0",
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    outputDir: ".buildchain/release-passport",
    assetsDir: "dist",
    productName: "Buildchain",
    packageName: "@kungfu-tech/buildchain",
    packageVersion: "2.9.0",
    kfd1WitnessJsons: [kfd1Path],
    kfd3PrebuildWitnessJsons: [kfd3PrebuildPath],
    kfd3ArtifactWitnessJsons: [kfd3ArtifactPath],
  });
  assert.equal(collection.checkReport.ok, true, JSON.stringify(collection.checkReport.issues, null, 2));
  return {
    cwd,
    passportPath: path.join(cwd, ".buildchain", "release-passport", "buildchain.release.json"),
  };
}

function createTapFixture() {
  const cwd = tempDir("tap");
  fs.mkdirSync(path.join(cwd, "Formula"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[project]
type = "distribution-index"
name = "homebrew-tap"
`);
  return cwd;
}

test("buildchain.toml accepts distribution-index projects", () => {
  const normalized = normalizeBuildchainConfig({
    schema: 1,
    project: {
      type: "distribution-index",
      name: "homebrew-tap",
    },
  });
  assert.deepEqual(normalized.project, {
    type: "distribution-index",
    name: "homebrew-tap",
  });
});

test("Homebrew API generates Formula and tap manifest from a verified release passport", async () => {
  const { passportPath } = createVerifiedReleasePassportFixture();
  const cwd = createTapFixture();
  const update = await updateHomebrewTap({ cwd, packageName: "buildchain", releasePassport: passportPath });
  const formula = fs.readFileSync(path.join(cwd, "Formula", "buildchain.rb"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "tap-manifest.json"), "utf8"));

  assert.deepEqual(update.written.sort(), ["Formula/buildchain.rb", "tap-manifest.json"]);
  assert.match(formula, /class Buildchain < Formula/);
  assert.match(formula, /version "2\.9\.0"/);
  assert.match(formula, /buildchain-aarch64-apple-darwin\.tar\.gz/);
  assert.match(formula, /buildchain-x86_64-unknown-linux-gnu\.tar\.gz/);
  assert.equal(manifest.contract, "kungfu-buildchain-homebrew-tap-manifest");
  assert.deepEqual(manifest.entries[0].kfd, {
    "kfd-1": "passed",
    "kfd-2": "passed",
    "kfd-3": "passed",
  });

  const check = await checkHomebrewTap({ cwd });
  assert.equal(check.ok, true, JSON.stringify(check.checks, null, 2));
});

test("Homebrew check fails closed when Formula drifts from upstream evidence", async () => {
  const { passportPath } = createVerifiedReleasePassportFixture();
  const cwd = createTapFixture();
  await updateHomebrewTap({ cwd, releasePassport: passportPath });
  const formulaPath = path.join(cwd, "Formula", "buildchain.rb");
  fs.writeFileSync(formulaPath, fs.readFileSync(formulaPath, "utf8").replace(/sha256 "[a-f0-9]+"/, 'sha256 "0"'));

  const check = await checkHomebrewTap({ cwd });
  assert.equal(check.ok, false);
  assert.equal(check.checks.find((entry) => entry.id === "formula.current").status, "fail");
});

test("Homebrew KFD passed cannot be claimed from an unverified passport", async () => {
  const cwd = createTapFixture();
  const passportPath = path.join(cwd, "fake-passport.json");
  writeJson(passportPath, {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport",
    product: {
      name: "Buildchain",
      repository: "kungfu-systems/buildchain",
    },
    release: {
      tag: "v2.9.1",
      publishedVersion: "2.9.1",
    },
    artifacts: [
      {
        name: "buildchain-aarch64-apple-darwin.tar.gz",
        platform: "darwin-arm64",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        name: "buildchain-x86_64-unknown-linux-gnu.tar.gz",
        platform: "linux-x64",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    "kfd-1": { status: "passed" },
    "kfd-2": { status: "passed" },
    "kfd-3": { status: "passed" },
  });
  await updateHomebrewTap({ cwd, releasePassport: passportPath });

  const facts = await collectHomebrewTapFacts({ cwd });
  assert.deepEqual(facts.kfd, {
    "kfd-1": "unverified",
    "kfd-2": "unverified",
    "kfd-3": "unverified",
  });
  const check = await checkHomebrewTap({ cwd });
  assert.equal(check.ok, false);
  assert.equal(check.checks.find((entry) => entry.id === "upstream-passport.verified").status, "fail");
});

test("Homebrew CLI uses the Node API for update and check", async () => {
  const { passportPath } = createVerifiedReleasePassportFixture();
  const cwd = createTapFixture();
  const update = spawnSync(process.execPath, [
    bin,
    "homebrew",
    "update-formula",
    "--cwd",
    cwd,
    "--package",
    "buildchain",
    "--release-passport",
    passportPath,
    "--write",
    "--json",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(update.status, 0, update.stderr);
  assert.equal(JSON.parse(update.stdout).written.includes("Formula/buildchain.rb"), true);

  const check = spawnSync(process.execPath, [
    bin,
    "homebrew",
    "check",
    "--cwd",
    cwd,
    "--json",
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(JSON.parse(check.stdout).ok, true);
});

test("renderHomebrewFormula is deterministic", async () => {
  const { passportPath } = createVerifiedReleasePassportFixture();
  const cwd = createTapFixture();
  const facts = await collectHomebrewTapFacts({ cwd, releasePassport: passportPath });
  assert.equal(renderHomebrewFormula(facts), renderHomebrewFormula(facts));
});
