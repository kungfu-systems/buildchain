import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLICATION_ARTIFACT_MANIFEST_CONTRACT,
  collectPublicationArtifact,
  writePublicationArtifact,
} from "../packages/core/publication-artifact.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "fixtures", "publication-artifact-shaped");

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
  assert.equal(result.manifest.toolchain.type, "custom-command");
  assert.equal(result.manifest.toolchain.trustClassification, "custom-command");
  assert.equal(result.manifest.artifacts.length, 1);
  assert.equal(result.manifest.metadata.length, 2);
  assert.equal(result.manifest.source.sourceBundle.path, ".buildchain/publication/source.tar.gz");
  assert.equal(fs.existsSync(path.join(cwd, result.manifestPath)), true);
  assert.equal(fs.existsSync(path.join(cwd, result.passportPath)), true);
  assert.equal(result.passport.status, "passed");
  assert.equal(result.passport.toolchain.type, "custom-command");
  assert.equal(result.passport.residualRisk.some((risk) => risk.id === "publication-custom-build-toolchain"), true);
});

test("publication artifact manifest records pinned latex docker toolchain", () => {
  const cwd = tempRepo();
  const configPath = path.join(cwd, ".buildchain", "buildchain.toml");
  fs.writeFileSync(
    configPath,
    `${fs.readFileSync(configPath, "utf8")}

[publication.toolchain]
type = "latex-docker"
image = "ghcr.io/kungfu-systems/latex"
digest = "sha256:${"a".repeat(64)}"
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
  assert.equal(result.manifest.toolchain.image, "ghcr.io/kungfu-systems/latex");
  assert.equal(result.manifest.toolchain.digest, `sha256:${"a".repeat(64)}`);
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
