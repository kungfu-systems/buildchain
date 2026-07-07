import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkReadmeBadgeBlock,
  collectReadmeBadgeFacts,
  renderReadmeBadgeBlock,
  updateReadmeBadgeBlock,
} from "@kungfu-tech/buildchain/readme-badges";
import { collectGitHubReleasePassport } from "@kungfu-tech/buildchain/release-passport";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-readme-badges-${name}-`));
}

function writeFixtureRepo({
  name = "@kungfu-systems/badge-fixture",
  repository = "https://github.com/kungfu-systems/badge-fixture.git",
  badges = "",
} = {}) {
  const cwd = tempDir("repo");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Badge Fixture\n\nBody.\n");
  fs.writeFileSync(path.join(cwd, "LICENSE"), "Apache-2.0\n");
  fs.writeFileSync(path.join(cwd, "package.json"), `${JSON.stringify({
    name,
    version: "0.1.0",
    license: "Apache-2.0",
    repository: { type: "git", url: repository },
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".github", "workflows", "verify.yml"), "name: Verify\non: push\n");
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[badges]
platforms = ["macOS", "Linux", "Windows"]
workflows = ["verify.yml"]
${badges}
`);
  return cwd;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function minimalKfdStandards() {
  return {
    schemaVersion: 1,
    contract: "kfd-standards-metadata",
    metadataSchema: {
      id: "https://kfd.libkungfu.dev/schemas/kfd-standards.schema.json",
      path: "schemas/kfd-standards.schema.json",
      version: "1",
    },
    standards: {
      "kfd-1": {
        key: "kfd-1",
        id: "KFD-1",
        label: "KFD-1",
        title: "Facts must not drift",
        document: { path: "decisions/kfd-1.md", url: "https://kfd.libkungfu.dev/1", sha256: "1".repeat(64) },
        concepts: { contractWorld: "contract world" },
        interfaces: {
          contractWorld: {
            contract: "kfd-1-contract-world",
            schemaId: "https://kfd.libkungfu.dev/schemas/kfd-1/contract-world.schema.json",
          },
        },
      },
      "kfd-2": {
        key: "kfd-2",
        id: "KFD-2",
        label: "KFD-2",
        title: "Trust must start from facts",
        document: { path: "decisions/kfd-2.md", url: "https://kfd.libkungfu.dev/2", sha256: "2".repeat(64) },
        concepts: { releaseTrustPassport: "release trust passport" },
        interfaces: {
          releaseTrustPassport: {
            contract: "kfd-2-release-trust-passport",
            schemaId: "https://kfd.libkungfu.dev/schemas/kfd-2/release-trust-passport.schema.json",
          },
        },
      },
      "kfd-3": {
        key: "kfd-3",
        id: "KFD-3",
        label: "KFD-3",
        title: "Cooperation must start from trusted value",
        document: { path: "decisions/kfd-3.md", url: "https://kfd.libkungfu.dev/3", sha256: "3".repeat(64) },
        concepts: { collaborationInterface: "collaboration interface" },
        interfaces: {
          collaborationInterface: {
            contract: "kfd-3-collaboration-interface",
            schemaId: "https://kfd.libkungfu.dev/schemas/kfd-3/collaboration-interface.schema.json",
          },
        },
      },
    },
  };
}

function writeKfdPackage(cwd, standards = minimalKfdStandards()) {
  const packageDir = path.join(cwd, "node_modules", "@kungfu-tech", "kfd");
  writeJson(path.join(packageDir, "standards.json"), standards);
  writeJson(path.join(packageDir, "package.json"), {
    name: "@kungfu-tech/kfd",
    version: "1.0.0-alpha.test",
    exports: {
      "./standards.json": "./standards.json",
      "./package.json": "./package.json",
    },
  });
  return packageDir;
}

function createMinimalKfdPassportRepo() {
  const cwd = writeFixtureRepo({
    badges: 'release_passport = ".buildchain/release-passport/buildchain.release.json"\n',
  });
  const surfacePath = path.join(cwd, "surface.txt");
  fs.writeFileSync(surfacePath, "declared public surface\n");
  const surfaceSha = sha256File(surfacePath);
  const kfd1Witness = {
    schemaVersion: 1,
    id: "fixture-contract-world",
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
  };
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
  const kfd3Prebuild = {
    schemaVersion: 1,
    id: "fixture-collaboration-interface",
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
  };
  const kfd3Artifact = {
    schemaVersion: 1,
    id: "fixture-collaboration-interface",
    standard: "kfd-3",
    artifact: {
      name: "@kungfu-systems/badge-fixture",
      path: "surface.txt",
      digest: `sha256:${surfaceSha}`,
    },
    exposedSurfaces: [publicSurface],
    verifier: {
      name: "fixture verifier",
    },
  };
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "fixture.tar.gz"), "fixture archive\n");
  const witnessDir = path.join(cwd, ".buildchain", "witnesses");
  const kfd1Path = writeJson(path.join(witnessDir, "kfd1.json"), kfd1Witness);
  const kfd3PrebuildPath = writeJson(path.join(witnessDir, "kfd3-prebuild.json"), kfd3Prebuild);
  const kfd3ArtifactPath = writeJson(path.join(witnessDir, "kfd3-artifact.json"), kfd3Artifact);
  const collection = collectGitHubReleasePassport({
    cwd,
    tag: "v0.1.0-alpha.1",
    repository: "kungfu-systems/badge-fixture",
    sourceSha: "a".repeat(40),
    outputDir: ".buildchain/release-passport",
    assetsDir: "dist",
    productName: "Badge Fixture",
    packageName: "@kungfu-systems/badge-fixture",
    packageVersion: "0.1.0-alpha.1",
    kfd1WitnessJsons: [kfd1Path],
    kfd3PrebuildWitnessJsons: [kfd3PrebuildPath],
    kfd3ArtifactWitnessJsons: [kfd3ArtifactPath],
  });
  assert.equal(collection.checkReport.ok, true, JSON.stringify(collection.checkReport.issues, null, 2));
  return cwd;
}

test("readme badge block inserts into a fresh README", async () => {
  const cwd = writeFixtureRepo({
    badges: 'kfd_1 = "declared"\nkfd_2 = "planned"\nkfd_3 = "aligned"\n',
  });
  const facts = await collectReadmeBadgeFacts({ cwd });
  const readme = fs.readFileSync(path.join(cwd, "README.md"), "utf8");
  const updated = updateReadmeBadgeBlock({ readmeText: readme, facts });

  assert.match(updated, /<!-- buildchain:badges:start -->/);
  assert.match(updated, /KFD-1: declared/);
  assert.match(updated, /Buildchain Release Passport: declared/);
  assert.match(updated, /buildchain-release%20passport%20declared/);
  assert.match(updated, /^# Badge Fixture\n\n?<!-- buildchain:badges:start -->/);
});

test("readme badge block replaces an existing managed block", async () => {
  const cwd = writeFixtureRepo({ badges: 'kfd_1 = "declared"\n' });
  const facts = await collectReadmeBadgeFacts({ cwd });
  const stale = "# Badge Fixture\n\n<!-- buildchain:badges:start -->\nstale\n<!-- buildchain:badges:end -->\n\nBody.\n";
  const updated = updateReadmeBadgeBlock({ readmeText: stale, facts });

  assert.doesNotMatch(updated, /stale/);
  assert.equal((updated.match(/buildchain:badges:start/g) || []).length, 1);
  assert.equal(checkReadmeBadgeBlock({ readmeText: updated, facts }).ok, true);
});

test("readme badge check detects missing and stale blocks", async () => {
  const cwd = writeFixtureRepo({ badges: 'kfd_1 = "declared"\n' });
  const facts = await collectReadmeBadgeFacts({ cwd });
  const missing = checkReadmeBadgeBlock({
    readmeText: "# Badge Fixture\n\nBody.\n",
    facts,
  });
  const stale = checkReadmeBadgeBlock({
    readmeText: "# Badge Fixture\n\n<!-- buildchain:badges:start -->\nstale\n<!-- buildchain:badges:end -->\n",
    facts,
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
});

test("repositories without a verified passport cannot display KFD passed", async () => {
  const cwd = writeFixtureRepo({
    badges: 'kfd_1 = "passed"\nkfd_2 = "passed"\nkfd_3 = "passed"\nrelease_passport_state = "passed"\n',
  });
  const facts = await collectReadmeBadgeFacts({ cwd });

  assert.deepEqual(facts.kfd.map((entry) => entry.state), ["declared", "declared", "declared"]);
  assert.equal(facts.kfd.some((entry) => entry.state === "passed"), false);
  assert.equal(facts.releasePassport.state, "declared");
  assert.match(renderReadmeBadgeBlock(facts), /KFD-1: declared/);
});

test("KFD badge text and provenance come from the KFD standards package", async () => {
  const cwd = writeFixtureRepo({
    badges: 'kfd_1 = "declared"\nkfd_2 = "aligned"\nkfd_3 = "planned"\n',
  });
  writeKfdPackage(cwd);

  const facts = await collectReadmeBadgeFacts({ cwd });
  const kfd2 = facts.kfd.find((entry) => entry.key === "kfd-2");

  assert.equal(facts.kfdStandards.contract, "kfd-standards-metadata");
  assert.equal(facts.kfdStandards.source, "package-export");
  assert.equal(facts.kfdStandards.package.name, "@kungfu-tech/kfd");
  assert.equal(facts.kfdStandards.package.version, "1.0.0-alpha.test");
  assert.equal(kfd2.text, "release trust passport");
  assert.equal(kfd2.standardDocumentUrl, "https://kfd.libkungfu.dev/2");
  assert.equal(kfd2.interfaceContract, "kfd-2-release-trust-passport");
  assert.match(renderReadmeBadgeBlock(facts), /release%20trust%20passport%20aligned/);
});

test("verified repository passport backs KFD passed badges and repo-specific links", async () => {
  const cwd = createMinimalKfdPassportRepo();
  const facts = await collectReadmeBadgeFacts({ cwd });

  assert.equal(facts.releasePassport.verified, true);
  assert.deepEqual(facts.kfd.map((entry) => entry.state), ["passed", "passed", "passed"]);
  assert.equal(
    facts.kfd.every((entry) => entry.url.endsWith("/.buildchain/release-passport/buildchain.release.json")),
    true,
  );
  assert.match(renderReadmeBadgeBlock(facts), /KFD-3: passed/);
});

test("CLI readme badge commands use the Node API", async () => {
  const cwd = writeFixtureRepo({ badges: 'kfd_1 = "declared"\n' });
  const missing = spawnSync(process.execPath, [bin, "badges", "readme", "--cwd", cwd, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /failed/);

  const written = execFileSync(process.execPath, [bin, "badges", "readme", "--cwd", cwd, "--write", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(written).contract, "kungfu-buildchain-readme-badge-write");

  const checked = execFileSync(process.execPath, [bin, "badges", "readme", "--cwd", cwd, "--check", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(checked).ok, true);
});
