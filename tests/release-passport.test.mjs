import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function createUnifiedPassportFixture({
  missingPlatformDigest = false,
  missingPublishArtifact = false,
  missingPublishVersion = false,
  productName = "Buildchain",
  trustedPublishingEnabled = true,
  tag = "v2.3.2",
  packageVersion = "",
  releaseExtra = {},
} = {}) {
  const cwd = tempDir("release-passport-core");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "linux-binary\n");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "@kungfu-tech/buildchain",
    version: "2.3.2",
  }, null, 2));

  const publishEvidencePath = writeJson(path.join(cwd, "publish-evidence.json"), {
    schema: 1,
    version: missingPublishVersion ? "" : "2.3.2",
    channel: "release",
    source_sha: "a".repeat(40),
    release_sha: "b".repeat(40),
    target_ref: "release/v2/v2.3",
    release_material_sha: "b".repeat(40),
    publish_tooling_sha: "c".repeat(40),
    artifacts: [
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain", ref: "2.3.2", digest: "sha512-main" },
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain-linux-x64", ref: "2.3.2", digest: "sha512-linux" },
      ...(!missingPublishArtifact
        ? [{ group: "node", kind: "npm", name: "@kungfu-tech/buildchain-darwin-arm64", ref: "2.3.2", digest: "sha512-darwin" }]
        : []),
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain-win32-x64", ref: "2.3.2", digest: "sha512-windows" },
    ],
  });
  const transactionPath = writeJson(path.join(cwd, "transaction.json"), {
    command: "finalize",
    transaction: {
      id: "kungfu-systems/buildchain:2.3.2:release/v2/v2.3",
      version: "2.3.2",
      state: "complete",
      previous_state: "finalizing",
      exact_tag: "v2.3.2",
      release_sha: "b".repeat(40),
      release_material_sha: "b".repeat(40),
      state_ref: "refs/heads/buildchain/release-state/2-3-2",
    },
    validation: { valid: true, errors: [] },
    durable: { sha: "d".repeat(40) },
  });
  const anchorManifestPath = writeJson(path.join(cwd, "anchor-manifest.json"), {
    npmVersion: "2.3.2",
    nodeVersion: "24.0.0",
  });
  const packageSetPath = writeJson(path.join(cwd, "package-set.json"), {
    order: "platforms-first-main-last",
    registry: "https://registry.npmjs.org/",
    main: {
      name: "@kungfu-tech/buildchain",
      version: "2.3.2",
      distTag: "latest",
      digest: "sha512-main",
    },
    platforms: [
      {
        name: "@kungfu-tech/buildchain-linux-x64",
        version: "2.3.2",
        distTag: "latest",
        digest: "sha512-linux",
        platform: "linux-x64",
      },
      {
        name: "@kungfu-tech/buildchain-darwin-arm64",
        version: "2.3.2",
        distTag: "latest",
        digest: missingPlatformDigest ? "" : "sha512-darwin",
        platform: "darwin-arm64",
      },
      {
        name: "@kungfu-tech/buildchain-win32-x64",
        version: "2.3.2",
        distTag: "latest",
        digest: "sha512-windows",
        platform: "win32-x64",
      },
    ],
  });
  const buildSummaryPath = writeJson(path.join(cwd, "build-summary.json"), {
    contract: "kungfu-buildchain-build-summary",
    artifactName: "buildchain",
    platformCount: 3,
    fileCount: 3,
    totalBytes: 123,
  });
  const linuxManifestPath = writeJson(path.join(cwd, "linux-manifest.json"), {
    artifactName: "buildchain-linux-x64",
    platform: { id: "linux-x64", name: "Linux x64" },
    summary: { fileCount: 1, totalBytes: 41 },
  });
  const darwinManifestPath = writeJson(path.join(cwd, "darwin-manifest.json"), {
    artifactName: "buildchain-darwin-arm64",
    platform: { id: "darwin-arm64", name: "Darwin arm64" },
    summary: { fileCount: 1, totalBytes: 41 },
  });
  const windowsManifestPath = writeJson(path.join(cwd, "windows-manifest.json"), {
    artifactName: "buildchain-win32-x64",
    platform: { id: "win32-x64", name: "Windows x64" },
    summary: { fileCount: 1, totalBytes: 41 },
  });
  const distTagEvidencePath = writeJson(path.join(cwd, "dist-tag-evidence.json"), {
    schema: 1,
    contract: "kungfu-buildchain-dist-tag-promotion-evidence",
    distTag: "latest",
    packages: [
      { name: "@kungfu-tech/buildchain", version: "2.3.2", distTag: "latest", role: "main" },
    ],
  });

  const collected = collectGitHubReleasePassport({
    cwd,
    tag,
    repository: "kungfu-systems/buildchain",
    productName,
    packageVersion,
    sourceSha: "a".repeat(40),
    assetsDir,
    publishEvidenceJson: publishEvidencePath,
    transactionJson: transactionPath,
    anchorManifestJson: anchorManifestPath,
    packageSetJson: packageSetPath,
    buildSummaryJson: buildSummaryPath,
    platformManifestJsons: [linuxManifestPath, darwinManifestPath, windowsManifestPath],
    distTagEvidenceJson: distTagEvidencePath,
    trustedPublishingJson: JSON.stringify({
      provider: "npm",
      enabled: trustedPublishingEnabled,
      auth: "trusted-publishing",
      workflowRunId: "12345",
    }),
    releaseJsonExtra: JSON.stringify({
      channel: "release",
      targetRef: "release/v2/v2.3",
      releaseSha: "b".repeat(40),
      ...releaseExtra,
    }),
    outputDir: "release-passport",
  });
  return path.join(collected.outputDir, "buildchain.release.json");
}

test("release passport core verifies unified three-platform npm passport", async () => {
  const passportPath = createUnifiedPassportFixture();
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));

  assert.equal(report.ok, true);
  assert.equal(passport.packageSet.platforms.length, 3);
  assert.equal(passport.publish.packages.length, 4);
  assert.equal(passport.publish.distTag, "latest");
  assert.equal(passport.transaction.result.command, "finalize");
  assert.equal(passport.buildSummary.fields.contract, "kungfu-buildchain-build-summary");
  assert.equal(passport.platformArtifactManifests.length, 3);
  assert.equal(passport.distTagPromotion.fields.distTag, "latest");
  assert.equal(report.completeness.buildSummaryPresent, true);
  assert.equal(report.completeness.platformArtifactManifestCount, 3);
  assert.equal(report.completeness.distTagPromotionEvidencePresent, true);
});

test("release passport core preserves supplied product name at root", async () => {
  const passportPath = createUnifiedPassportFixture({ productName: "Libnode" });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const productMechanism = JSON.parse(fs.readFileSync(path.join(path.dirname(passportPath), "product-mechanism.json"), "utf8"));

  assert.equal(passport.product.name, "Libnode");
  assert.equal(productMechanism.product.name, "Libnode");
});

test("release passport core separates anchored manual internal tags from published versions", async () => {
  const passportPath = createUnifiedPassportFixture({
    productName: "Libnode",
    tag: "v22.22.1-alpha.1",
    packageVersion: "22.22.3-kf.3-alpha.7",
    releaseExtra: {
      channel: "alpha",
      targetRef: "alpha/v22/v22.22",
      internalTag: "v22.22.1-alpha.1",
      internalVersion: "22.22.1-alpha.1",
      publishedVersion: "22.22.3-kf.3-alpha.7",
      versionLabel: "22.22.3-kf.3-alpha.7",
    },
  });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));

  assert.equal(passport.release.tag, "v22.22.1-alpha.1");
  assert.equal(passport.release.internalTag, "v22.22.1-alpha.1");
  assert.equal(passport.release.internalVersion, "22.22.1-alpha.1");
  assert.equal(passport.release.publishedVersion, "22.22.3-kf.3-alpha.7");
  assert.equal(passport.release.versionLabel, "22.22.3-kf.3-alpha.7");
  assert.equal(passport.release.package.version, "22.22.3-kf.3-alpha.7");
});

test("release passport core fails closed on incomplete platform package evidence", async () => {
  const passportPath = createUnifiedPassportFixture({ missingPlatformDigest: true });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /packageSet\.platforms\[1\]\.digest/);
});

test("release passport core fails closed when package set lacks publish artifact evidence", async () => {
  const passportPath = createUnifiedPassportFixture({ missingPublishArtifact: true });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /packageSet\.platforms\[1\]\.artifact/);
});

test("release passport core fails closed on incomplete publish evidence header", async () => {
  const passportPath = createUnifiedPassportFixture({ missingPublishVersion: true });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /publishEvidence\.version/);
});

test("release passport core fails closed when trusted publishing is disabled", async () => {
  const passportPath = createUnifiedPassportFixture({ trustedPublishingEnabled: false });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /trustedPublishing\.enabled/);
});

test("release passport core fails closed on missing anchor manifest digest", async () => {
  const passportPath = createUnifiedPassportFixture();
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  passport.anchorManifest.sha256 = "";
  fs.writeFileSync(passportPath, `${JSON.stringify(passport, null, 2)}\n`);

  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /anchorManifest\.sha256/);
});
