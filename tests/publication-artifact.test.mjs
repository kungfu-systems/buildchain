import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLICATION_ARTIFACT_ARCHIVE_CONTRACT,
  PUBLICATION_ARTIFACT_MANIFEST_CONTRACT,
  PUBLICATION_ARTIFACT_REGISTRY_CONTRACT,
  collectPublicationArtifact,
  writePublicationArtifact,
} from "../packages/core/publication-artifact.js";
import { PUBLICATION_NPM_PACKAGE_CONTRACT } from "../packages/core/publication-package.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "fixtures", "publication-artifact-shaped");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-publication-"));
  fs.cpSync(fixture, cwd, { recursive: true });
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd, stdio: "ignore" });
  return cwd;
}

test("publication artifact manifest records PDF metadata and source bundle", () => {
  const cwd = tempRepo();
  execFileSync("make", ["pdf"], { cwd });
  const result = writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-09T00:00:00.000Z",
  });

  assert.equal(result.manifest.contract, PUBLICATION_ARTIFACT_MANIFEST_CONTRACT);
  assert.equal(result.manifest.project.type, "publication-artifact");
  assert.equal(result.manifest.publication.primaryArtifact, "_build/main.pdf");
  assert.equal(result.manifest.publication.version, "0.1.0");
  assert.equal(result.manifest.publication.archive.contract, PUBLICATION_ARTIFACT_ARCHIVE_CONTRACT);
  assert.equal(result.manifest.publication.archive.id, "observer-declared-timelines");
  assert.equal(
    result.manifest.publication.archive.routes.immutableVersionUrl,
    "https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0/",
  );
  assert.equal(result.manifest.toolchain.type, "custom-command");
  assert.equal(result.manifest.toolchain.trustClassification, "custom-command");
  assert.equal(result.manifest.artifacts.length, 1);
  assert.equal(result.manifest.metadata.length, 2);
  assert.equal(result.manifest.source.sourceBundle.path, ".buildchain/publication/source.tar.gz");
  assert.equal(fs.existsSync(path.join(cwd, result.manifestPath)), true);
  assert.equal(fs.existsSync(path.join(cwd, result.passportPath)), true);
  assert.equal(fs.existsSync(path.join(cwd, result.registryPath)), true);
  assert.equal(result.passport.status, "passed");
  assert.equal(result.passport.publicationArchive.contract, PUBLICATION_ARTIFACT_ARCHIVE_CONTRACT);
  assert.equal(result.passport.toolchain.type, "custom-command");
  assert.equal(result.passport.residualRisk.some((risk) => risk.id === "publication-custom-build-toolchain"), true);
  assert.equal(result.registry.registry.contract, PUBLICATION_ARTIFACT_REGISTRY_CONTRACT);
  assert.equal(result.registry.registry.versions.length, 1);
  assert.equal(result.registry.registry.versions[0].version, "0.1.0");
  assert.equal(result.registry.registry.versions[0].routes.canonicalUrl, "https://papers.libkungfu.dev/observer-declared-timelines/");
  assert.equal(result.registry.registry.versions[0].artifacts[0].role, "primary");
  assert.match(result.registry.registry.versions[0].immutableDigest, /^sha256:[0-9a-f]{64}$/);
});

test("publication artifact manifest records pinned latex docker toolchain", () => {
  const cwd = tempRepo();
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.writeFileSync(
    configPath,
    `${fs.readFileSync(configPath, "utf8")}

[publication.toolchain]
type = "latex-docker"
image = "ghcr.io/kungfu-systems/build-images/latex-pdf-builder"
digest = "sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8"
command = "latexmk -pdf -outdir=_build paper/main.tex"
`,
  );
  execFileSync("make", ["pdf"], { cwd });
  const result = writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-09T00:00:00.000Z",
  });

  assert.equal(result.manifest.toolchain.type, "latex-docker");
  assert.equal(result.manifest.toolchain.image, "ghcr.io/kungfu-systems/build-images/latex-pdf-builder");
  assert.equal(result.manifest.toolchain.digest, "sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8");
  assert.equal(result.manifest.toolchain.command, "latexmk -pdf -outdir=_build paper/main.tex");
  assert.equal(result.manifest.toolchain.machineVerifiable, true);
  assert.equal(result.passport.toolchain.trustClassification, "pinned-docker-toolchain");
  assert.equal(result.passport.residualRisk.some((risk) => risk.id === "publication-custom-build-toolchain"), false);
});

test("publication artifact collection fails when primary artifact is missing", () => {
  const cwd = tempRepo();
  assert.throws(
    () => collectPublicationArtifact({ cwd, sourceBundle: false }),
    /publication primary artifact is missing: _build\/main\.pdf/,
  );
});

test("publication artifact CLI synthesizes npm package from declared paper facts", () => {
  const cwd = tempRepo();
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.writeFileSync(
    configPath,
    `${fs.readFileSync(configPath, "utf8")}

[publish]
kind = "npm-paper-package"
package = "@kungfu-tech/paper-observer-declared-timelines"
auth = "trusted-publishing"
`,
  );
  execFileSync("make", ["pdf"], { cwd });
  writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-09T00:00:00.000Z",
  });

  const result = JSON.parse(execFileSync(process.execPath, [
    bin,
    "publication-artifact",
    "npm-package",
    "--cwd",
    cwd,
    "--json",
  ], { cwd, encoding: "utf8" }));

  assert.equal(result.contract, PUBLICATION_NPM_PACKAGE_CONTRACT);
  assert.equal(result.package.name, "@kungfu-tech/paper-observer-declared-timelines");
  assert.equal(result.package.version, "0.1.0");
  assert.equal(result.package.auth, "trusted-publishing");
  assert.equal(result.publication.primaryArtifact, "_build/main.pdf");
  const packageDir = path.join(cwd, result.outputDir);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@kungfu-tech/paper-observer-declared-timelines");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.exports["./publication-artifact.json"], "./.buildchain/publication/publication-artifact.json");
  assert.equal(fs.existsSync(path.join(packageDir, "_build/main.pdf")), true);
  assert.equal(fs.existsSync(path.join(packageDir, ".buildchain/publication/publication-artifact.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, ".buildchain/publication/publication-artifact-passport.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, ".buildchain/publication/publication-registry.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, ".buildchain/publication/source.tar.gz")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "buildchain-publication-package.json")), true);
});

test("publication archive registry is idempotent for the same immutable record", () => {
  const cwd = tempRepo();
  execFileSync("make", ["pdf"], { cwd });
  const first = writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-09T00:00:00.000Z",
  });
  const second = writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  assert.equal(second.registry.registry.versions.length, 1);
  assert.equal(second.registry.registry.versions[0].immutableDigest, first.registry.registry.versions[0].immutableDigest);
  assert.equal(second.registry.registry.versions[0].publishedAt, "2026-07-09T00:00:00.000Z");
  assert.equal(second.registry.registry.versions[0].latestObservedAt, "2026-07-10T00:00:00.000Z");
});

test("publication archive registry rejects changed artifact digest for an existing version", () => {
  const cwd = tempRepo();
  execFileSync("make", ["pdf"], { cwd });
  writePublicationArtifact({
    cwd,
    sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    generatedAt: "2026-07-09T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(cwd, "_build", "main.pdf"), "changed paper bytes\n");

  assert.throws(
    () => writePublicationArtifact({
      cwd,
      sourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      generatedAt: "2026-07-10T00:00:00.000Z",
    }),
    /publication archive version 0\.1\.0 is immutable/,
  );
});
