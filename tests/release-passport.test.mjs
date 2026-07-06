import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  explainArtifactPassport,
  resolveArtifactSubject,
  verifyArtifactPassport,
} from "../packages/core/artifact-passport.js";
import {
  collectGitHubReleasePassport,
  explainReleasePassport,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";
import {
  resolveKfd1Metadata,
  resolveKfd3Metadata,
  sha256File as sha256KfdFile,
} from "../packages/core/kfd-gate.js";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function createKfdWitnessFixture({ id = "generic-contracts", artifactPath = "config.schema.json", content = "{\"ok\":true}\n", expectedSha256 = "" } = {}) {
  const cwd = tempDir("kfd-1-gate");
  const assetsDir = path.join(cwd, "dist");
  const artifactFile = path.join(assetsDir, artifactPath);
  fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
  fs.writeFileSync(artifactFile, content);
  const metadata = resolveKfd1Metadata();
  const actualSha256 = sha256KfdFile(artifactFile);
  const witnessPath = writeJson(path.join(cwd, "kfd-1-witness.json"), {
    id,
    standard: metadata.key,
    source: {
      repo: id.startsWith("kungfu") ? "kungfu-systems/kungfu" : "example/project",
      ref: "a".repeat(40),
    },
    contractWorld: {
      schemaId: metadata.schemaIds.contractWorld,
      digest: `sha256:${actualSha256}`,
    },
    canonicalPolicy: {
      path: "contracts/canonical-policy.json",
      sha256: actualSha256,
    },
    registry: {
      path: "contracts/registry.json",
      sha256: actualSha256,
    },
    surfaces: [
      {
        name: id.startsWith("kungfu") ? "config.schema" : "generic.schema",
        sourcePath: "src/contracts/config.schema.json",
        sourceSha256: actualSha256,
        artifactPath,
        expectedSha256: expectedSha256 || actualSha256,
        byteForByte: true,
      },
    ],
  });
  return { cwd, assetsDir, artifactFile, witnessPath, metadata, actualSha256 };
}

function createKfd3WitnessFixture({
  reachableEntrypoints = ["agent-verify"],
  declaredSurfaceId = "agent-verify",
  artifactDigest = "sha256:ci-digest",
  prebuildDigest = "sha256:ci-digest",
} = {}) {
  const cwd = tempDir("kfd-3-gate");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "kungfu-package.tgz"), "package\n");
  const metadata = resolveKfd3Metadata({ requireSchemas: true });
  const prebuildWitnessPath = writeJson(path.join(cwd, "kfd-3-prebuild.json"), {
    id: "kungfu-agent-bridge",
    standard: metadata.key,
    supportLevel: "release",
    source: {
      repo: "kungfu-systems/kungfu",
      ref: "a".repeat(40),
    },
    sourceRegistry: {
      path: "src/agent/collaboration-interface.json",
      sha256: "1".repeat(64),
    },
    collaborationInterfaceDigest: prebuildDigest,
    collaborationInterface: {
      schemaVersion: 1,
      contract: "kfd-3-collaboration-interface",
      standard: metadata.key,
      product: {
        name: "Kungfu",
        version: "4.0.0-alpha.0",
        repository: "kungfu-systems/kungfu",
      },
      sourceRegistry: {
        path: "src/agent/collaboration-interface.json",
        sha256: "1".repeat(64),
      },
      participants: [
        { id: "agent", kind: "agent", description: "Automation agent using the public bridge." },
      ],
      minimalEntrypoints: [
        { id: "agent-verify", surface: "agent-verify", participants: ["agent"], purpose: "Verify shipped agent-facing controls." },
      ],
      surfaces: [
        {
          id: declaredSurfaceId,
          kind: "cli-command",
          participants: ["agent"],
          value: "Artifact-level KFD-3 verification command.",
          discoverability: { fromMinimalEntrypoint: true, path: "docs/MAP.md" },
          maturity: "stable",
        },
      ],
      transparentConstraints: [],
      choicePaths: [],
      closure: {
        classificationMode: "closed-world",
        unclassifiedEntrypointsPolicy: "fail",
      },
    },
  });
  const artifactWitness = {
    id: "kungfu-agent-bridge",
    standard: metadata.key,
    collaborationInterface: {
      schemaId: metadata.schemaIds.collaborationInterface,
      digest: artifactDigest,
    },
    sourceRegistry: {
      path: "src/agent/collaboration-interface.json",
      sha256: "1".repeat(64),
    },
    artifact: {
      name: "kungfu-package.tgz",
      path: "dist/kungfu-package.tgz",
      digest: `sha256:${"2".repeat(64)}`,
    },
    evidence: {
      minimalEntrypoints: [{ path: "docs/MAP.md", sha256: "3".repeat(64) }],
      discoverability: [],
      transparentConstraints: [],
      choicePaths: [],
    },
    closure: {
      classificationMode: "closed-world",
      reachableEntrypoints,
      classifiedEntrypoints: reachableEntrypoints,
      unclassifiedEntrypoints: [],
    },
    result: "pass",
  };
  const artifactWitnessPath = writeJson(path.join(cwd, "kfd-3-artifact.json"), artifactWitness);
  return { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, artifactWitness, metadata };
}

function defaultSurfaceImpactLedger() {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { tag: "v2.3.2", line: "v2.3" },
    versionImpact: {
      final: "patch",
      source: "surface-register",
      rationale: "Patch release with no registered surface compatibility change.",
    },
    surfaceImpacts: [
      {
        id: "release-governance",
        impact: "patch",
        class: "compatible",
        rationale: "Release evidence is complete without changing a registered public surface.",
      },
    ],
  };
}

function createArtifactPassportFixture({ fileName = "Kungfu-2.8.0-windows-x64.exe", content = "binary\n" } = {}) {
  const cwd = tempDir("artifact-passport");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  const artifactPath = path.join(assetsDir, fileName);
  fs.writeFileSync(artifactPath, content);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "@kungfu-tech/kungfu",
    version: "2.8.0",
  }, null, 2));
  const impactPath = writeJson(path.join(cwd, "impact.json"), defaultSurfaceImpactLedger());
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v2.8.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "a".repeat(40),
    assetsDir,
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "release",
      targetRef: "release/v2/v2.8",
      releaseSha: "b".repeat(40),
    }),
    impactJson: impactPath,
  });
  return {
    cwd,
    artifactPath,
    passportPath: path.join(collected.outputDir, "buildchain.release.json"),
    outputDir: collected.outputDir,
  };
}

async function withHttpFixture(files, fn) {
  const server = http.createServer((request, response) => {
    const body = files[request.url] || files[decodeURIComponent(request.url || "")];
    if (body === undefined) {
      response.writeHead(404);
      response.end("missing");
      return;
    }
    response.writeHead(200, { "content-type": request.url.endsWith(".json") ? "application/json" : "application/octet-stream" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
  impact = defaultSurfaceImpactLedger(),
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
    channel: releaseExtra.channel || "release",
    source_sha: "a".repeat(40),
    release_sha: "b".repeat(40),
    target_ref: releaseExtra.targetRef || releaseExtra.target_ref || "release/v2/v2.3",
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
  const impactPath = impact ? writeJson(path.join(cwd, "impact.json"), impact) : "";

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
    impactJson: impactPath,
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

test("artifact passport verification passes for a local installer with explicit passport", async () => {
  const fixture = createArtifactPassportFixture();
  const report = await verifyArtifactPassport({
    subject: fixture.artifactPath,
    passportLocation: fixture.passportPath,
  });

  assert.equal(report.contract, "kungfu-buildchain-artifact-verification");
  assert.equal(report.outcome, "pass");
  assert.equal(report.ok, true);
  assert.equal(report.subject.kind, "native-installer");
  assert.equal(report.discovery.method, "explicit-passport");
  assert.equal(report.match.source, "passport.artifacts");
});

test("artifact passport discovery follows a sidecar pointer", async () => {
  const fixture = createArtifactPassportFixture();
  writeJson(`${fixture.artifactPath}.buildchain-passport.json`, {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-passport-pointer",
    passport: path.relative(path.dirname(fixture.artifactPath), fixture.passportPath),
  });

  const report = await verifyArtifactPassport({
    subject: fixture.artifactPath,
    cwd: fixture.cwd,
  });

  assert.equal(report.ok, true);
  assert.equal(report.discovery.method, "sidecar-pointer");
});

test("artifact passport discovery supports local locator indexes", async () => {
  const fixture = createArtifactPassportFixture();
  const subject = await resolveArtifactSubject(fixture.artifactPath);
  writeJson(path.join(fixture.cwd, ".buildchain", "artifact-passport-locators.json"), {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-passport-locator",
    locators: [
      {
        match: { name: subject.name, digest: subject.digest },
        passport: path.relative(path.join(fixture.cwd, ".buildchain"), fixture.passportPath),
      },
    ],
  });

  const report = await verifyArtifactPassport({
    subject: fixture.artifactPath,
    cwd: fixture.cwd,
  });

  assert.equal(report.ok, true);
  assert.equal(report.discovery.method, "local-config-index");
});

test("artifact passport default GitHub Release discovery can verify release assets", async () => {
  const fixture = createArtifactPassportFixture({ fileName: "Kungfu-2.8.0-linux-x64.tar.gz" });
  const releasePath = "/kungfu-systems/kungfu/releases/download/v2.8.0";
  const passport = fs.readFileSync(fixture.passportPath);
  const artifactEvidence = fs.readFileSync(path.join(fixture.outputDir, "artifact-evidence.json"));
  const impact = fs.readFileSync(path.join(fixture.outputDir, "impact.json"));
  const agentIndex = fs.readFileSync(path.join(fixture.outputDir, "agent-index.json"));
  const productMechanism = fs.readFileSync(path.join(fixture.outputDir, "product-mechanism.json"));
  const artifact = fs.readFileSync(fixture.artifactPath);

  await withHttpFixture({
    [`${releasePath}/Kungfu-2.8.0-linux-x64.tar.gz`]: artifact,
    [`${releasePath}/buildchain.release.json`]: passport,
    [`${releasePath}/artifact-evidence.json`]: artifactEvidence,
    [`${releasePath}/impact.json`]: impact,
    [`${releasePath}/agent-index.json`]: agentIndex,
    [`${releasePath}/product-mechanism.json`]: productMechanism,
  }, async (baseUrl) => {
    const report = await verifyArtifactPassport({
      subject: `${baseUrl}${releasePath}/Kungfu-2.8.0-linux-x64.tar.gz`,
      githubReleaseBaseUrl: baseUrl,
    });
    assert.equal(report.ok, true);
    assert.equal(report.discovery.method, "github-release-default");
  });
});

test("artifact passport discovery falls back to a custom locator after GitHub default miss", async () => {
  const fixture = createArtifactPassportFixture({ fileName: "Kungfu-2.8.0-linux-x64.tar.gz" });
  const releasePath = "/kungfu-systems/kungfu/releases/download/v2.8.0";
  const artifact = fs.readFileSync(fixture.artifactPath);

  await withHttpFixture({
    [`${releasePath}/Kungfu-2.8.0-linux-x64.tar.gz`]: artifact,
  }, async (baseUrl) => {
    const subject = await resolveArtifactSubject(`${baseUrl}${releasePath}/Kungfu-2.8.0-linux-x64.tar.gz`);
    const locatorPath = writeJson(path.join(fixture.cwd, "custom-locator.json"), {
      schemaVersion: 1,
      contract: "kungfu-buildchain-artifact-passport-locator",
      locators: [
        {
          match: { name: subject.name, digest: subject.digest },
          passport: fixture.passportPath,
        },
      ],
    });
    const report = await verifyArtifactPassport({
      subject: `${baseUrl}${releasePath}/Kungfu-2.8.0-linux-x64.tar.gz`,
      githubReleaseBaseUrl: baseUrl,
      locatorConfig: locatorPath,
    });
    assert.equal(report.ok, true);
    assert.equal(report.discovery.method, "custom-locator");
    assert.equal(report.discovery.attempts.some((attempt) => attempt.method === "github-release-default" && attempt.status === "miss"), true);
  });
});

test("artifact passport verification fails closed on digest mismatch", async () => {
  const fixture = createArtifactPassportFixture();
  fs.writeFileSync(fixture.artifactPath, "tampered\n");

  const report = await verifyArtifactPassport({
    subject: fixture.artifactPath,
    passportLocation: fixture.passportPath,
  });

  assert.equal(report.ok, false);
  assert.equal(report.outcome, "fail");
  assert.match(JSON.stringify(report.issues), /subject\.digest\.missing/);
});

test("artifact passport verification is unverifiable without a passport locator", async () => {
  const cwd = tempDir("artifact-passport-missing");
  const artifactPath = path.join(cwd, "Kungfu-2.8.0-windows-x64.exe");
  fs.writeFileSync(artifactPath, "binary\n");

  const report = await verifyArtifactPassport({
    subject: artifactPath,
    cwd,
  });

  assert.equal(report.ok, false);
  assert.equal(report.outcome, "unverifiable");
  assert.match(JSON.stringify(report.issues), /passport\.unavailable/);
});

test("artifact passport verification supports installed npm package directories", async () => {
  const cwd = tempDir("artifact-passport-npm-dir");
  const packageDir = path.join(cwd, "node_modules", "@kungfu-tech", "buildchain");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@kungfu-tech/buildchain",
    version: "2.8.0",
  }, null, 2));
  fs.writeFileSync(path.join(packageDir, "index.js"), "export default 1;\n");
  const subject = await resolveArtifactSubject(packageDir);
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "binary\n");
  const impactPath = writeJson(path.join(cwd, "impact.json"), defaultSurfaceImpactLedger());
  const packageSetPath = writeJson(path.join(cwd, "package-set.json"), {
    order: "platforms-first-main-last",
    registry: "https://registry.npmjs.org/",
    main: {
      name: "@kungfu-tech/buildchain",
      version: "2.8.0",
      distTag: "latest",
      digest: subject.digest,
    },
    platforms: [
      { name: "@kungfu-tech/buildchain-linux-x64", version: "2.8.0", distTag: "latest", digest: "sha512-linux", platform: "linux-x64" },
      { name: "@kungfu-tech/buildchain-darwin-arm64", version: "2.8.0", distTag: "latest", digest: "sha512-darwin", platform: "darwin-arm64" },
      { name: "@kungfu-tech/buildchain-win32-x64", version: "2.8.0", distTag: "latest", digest: "sha512-windows", platform: "win32-x64" },
    ],
  });
  const publishEvidencePath = writeJson(path.join(cwd, "publish-evidence.json"), {
    schema: 1,
    version: "2.8.0",
    channel: "release",
    source_sha: "a".repeat(40),
    release_sha: "b".repeat(40),
    target_ref: "release/v2/v2.8",
    release_material_sha: "b".repeat(40),
    publish_tooling_sha: "c".repeat(40),
    artifacts: [
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain", ref: "2.8.0", digest: subject.digest },
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain-linux-x64", ref: "2.8.0", digest: "sha512-linux" },
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain-darwin-arm64", ref: "2.8.0", digest: "sha512-darwin" },
      { group: "node", kind: "npm", name: "@kungfu-tech/buildchain-win32-x64", ref: "2.8.0", digest: "sha512-windows" },
    ],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v2.8.0",
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    assetsDir,
    packageSetJson: packageSetPath,
    publishEvidenceJson: publishEvidencePath,
    impactJson: impactPath,
    releaseJsonExtra: JSON.stringify({
      channel: "release",
      targetRef: "release/v2/v2.8",
      releaseSha: "b".repeat(40),
    }),
    outputDir: "release-passport",
  });

  const report = await verifyArtifactPassport({
    subject: packageDir,
    passportLocation: path.join(collected.outputDir, "buildchain.release.json"),
  });
  const explanation = await explainArtifactPassport({
    subject: packageDir,
    passportLocation: path.join(collected.outputDir, "buildchain.release.json"),
    forAudience: "agent",
  });

  assert.equal(report.ok, true);
  assert.ok(["passport.artifacts", "publish-evidence.artifacts", "packageSet"].includes(report.match.source));
  assert.equal(explanation.audience, "agent");
  assert.equal(explanation.nextAction, "use-artifact-after-policy-review");
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

test("release passport records surface-aware minor impact for additive KFD registry schema", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      release: { tag: "v2.3.2", line: "v2.3" },
      versionImpact: {
        final: "minor",
        source: "surface-register",
        rationale: "KFD content is patch, but registry.kind additively evolves the machine registry schema.",
      },
      surfaceImpacts: [
        {
          id: "kfd-content",
          impact: "patch",
          class: "content",
          rationale: "KFD-2 adds append-only decision content.",
        },
        {
          id: "kfd-registry-schema",
          impact: "minor",
          class: "additive",
          rationale: "registry.kind is an additive field on the machine-consumed KFD registry surface.",
        },
      ],
      summary: "KFD-2 content is patch; registry schema additive field requires minor-impact review.",
    },
  });

  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const explanation = await explainReleasePassport({ passportLocation: passportPath, forAudience: "agent" });

  assert.equal(report.ok, true);
  assert.equal(report.completeness.versionImpact, "minor");
  assert.equal(report.completeness.surfaceImpactCount, 2);
  assert.equal(passport.versionImpact.final, "minor");
  assert.equal(passport.surfaceImpacts[1].id, "kfd-registry-schema");
  assert.equal(explanation.impact.versionImpact.final, "minor");
  assert.match(explanation.impact.surfaceImpacts[1].rationale, /registry\.kind/);
});

test("release passport records generic KFD-1 contract-world gate evidence from KFD metadata", async () => {
  const { cwd, assetsDir, witnessPath, metadata, actualSha256 } = createKfdWitnessFixture();
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.2.3-alpha.0",
    repository: "example/project",
    sourceSha: "a".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.2",
    }),
    kfd1WitnessJsons: [witnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, true);
  assert.ok(passport[metadata.key]);
  assert.equal(passport[metadata.key].status, "passed");
  assert.equal(passport[metadata.key].metadata.schemas.ids.witness, metadata.schemaIds.witness);
  assert.equal(passport[metadata.key].metadata.package.name, "@kungfu-tech/kfd");
  assert.equal(passport[metadata.key].formatting.name, "buildchain-release-evidence-json-v1");
  assert.equal(passport[metadata.key].contractWorlds[0].artifactVerification.surfaces[0].actualSha256, actualSha256);
  assert.equal(passport.evidence.kfd1, metadata.key);
});

test("release passport records Kungfu-shaped KFD-1 gate without invoking Kungfu SDK commands", async () => {
  const { cwd, assetsDir, witnessPath, metadata } = createKfdWitnessFixture({
    id: "kungfu-config",
    artifactPath: "Contents/Resources/core/config.schema.json",
    content: "{\"kungfu\":true}\n",
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "b".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd1WitnessJsons: [witnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const implementation = fs.readFileSync(path.resolve("packages/core/kfd-gate.js"), "utf8");

  assert.equal(passport[metadata.key].contractWorlds[0].id, "kungfu-config");
  assert.equal(passport[metadata.key].contractWorlds[0].artifactVerification.status, "passed");
  assert.doesNotMatch(implementation, /kfsdk|kungfu\s+sdk|kungfu contract/i);
});

test("release passport fails closed when KFD-1 artifact digest mismatches the frozen witness", async () => {
  const { cwd, assetsDir, witnessPath, metadata } = createKfdWitnessFixture({
    expectedSha256: "0".repeat(64),
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.2.3-alpha.0",
    repository: "example/project",
    sourceSha: "c".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.2",
    }),
    kfd1WitnessJsons: [witnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));

  assert.equal(passport[metadata.key].status, "failed");
  assert.equal(report.ok, false);
  assert.equal(report.issues.some((entry) => entry.code.includes(`${metadata.key}.contractWorlds`)), true);
  assert.match(JSON.stringify(report.issues), /digest mismatch|artifact verification/i);
});

test("release passport records KFD-3 collaboration-interface closure evidence", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture();
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, true);
  assert.equal(passport[metadata.key].status, "passed");
  assert.equal(passport[metadata.key].metadata.schemas.ids.witness, metadata.schemaIds.witness);
  assert.equal(passport[metadata.key].metadata.schemas.hasCollaborationSchemas, true);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].comparison.status, "passed");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].comparison.declaredShippedPublicSurfaceCount, 1);
  assert.equal(passport.evidence.kfd3, metadata.key);
});

test("release passport can collect KFD-3 artifact witness from product verify command", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitness, metadata } = createKfd3WitnessFixture();
  const commandFixturePath = writeJson(path.join(cwd, "emit-artifact-witness.mjs"), artifactWitness);
  fs.writeFileSync(commandFixturePath, `process.stdout.write(${JSON.stringify(JSON.stringify(artifactWitness))});\n`);

  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactVerifyCommand: `${process.execPath} ${commandFixturePath}`,
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, true);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].artifactWitness.id, "kungfu-agent-bridge");
});

test("release passport fails closed when KFD-3 declared shipped surface is absent from artifact", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture({
    reachableEntrypoints: [],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "e".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport[metadata.key].status, "failed");
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /missing declared shipped|missingDeclaredShipped|declared-shipped-surface-missing/i);
});

test("release passport fails closed when KFD-3 artifact exposes undeclared public surface", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture({
    reachableEntrypoints: ["agent-verify", "hidden-command"],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "f".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport[metadata.key].status, "failed");
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /hidden-command|unclassifiedArtifactPublic|not declared/i);
});

test("release passport fails closed when KFD-3 artifact witness points at stale collaboration-interface digest", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture({
    artifactDigest: "sha256:stale",
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "a".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport[metadata.key].status, "failed");
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(passport[metadata.key].collaborationInterfaces[0].comparison.reasons), /collaboration-interface-digest-mismatch/);
});

test("release passport rejects invalid KFD-3 prebuild witness without declared surfaces", () => {
  const { cwd, assetsDir, artifactWitnessPath, metadata } = createKfd3WitnessFixture();
  const invalidPrebuild = writeJson(path.join(cwd, "invalid-kfd-3-prebuild.json"), {
    id: "kungfu-agent-bridge",
    standard: metadata.key,
    supportLevel: "release",
  });

  assert.throws(() => collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "b".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v4/v4.0",
    }),
    kfd3PrebuildWitnessJsons: [invalidPrebuild],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  }), /declare at least one collaboration\/control surface/);
});

test("release passport requires surface impacts for production release passports", async () => {
  const passportPath = createUnifiedPassportFixture({ impact: null });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.equal(report.surfaceImpactRequirement.required, true);
  assert.equal(report.surfaceImpactRequirement.type, "production-release");
  assert.match(JSON.stringify(report.issues), /surfaceImpacts\[\] is required/);
});

test("release passport requires surface impacts for major publish gates", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: null,
    releaseExtra: {
      channel: "major",
      targetRef: "publish-gate/major",
    },
  });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.equal(report.surfaceImpactRequirement.required, true);
  assert.equal(report.surfaceImpactRequirement.type, "major-gate");
  assert.equal(report.surfaceImpactRequirement.targetRef, "publish-gate/major");
  assert.equal(report.issues.some((entry) => entry.code === "impact.surfaceImpacts.required"), true);
});

test("release passport keeps surface impacts optional for alpha passports", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: null,
    releaseExtra: {
      channel: "alpha",
      targetRef: "alpha/v2/v2.3",
    },
  });
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const explanation = await explainReleasePassport({ passportLocation: passportPath, forAudience: "agent" });

  assert.equal(report.ok, true);
  assert.equal(report.surfaceImpactRequirement.required, false);
  assert.equal(report.completeness.surfaceImpactCount, 0);
  assert.equal(explanation.impact.surfaceImpactRequirement.required, false);
});

test("release passport fails closed when final impact is lower than a surface impact", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      release: { tag: "v2.3.2", line: "v2.3" },
      versionImpact: {
        final: "patch",
        source: "surface-register",
        rationale: "Incorrectly declared as patch.",
      },
      surfaceImpacts: [
        {
          id: "kfd-registry-schema",
          impact: "minor",
          class: "additive",
          rationale: "registry.kind additively evolves the machine registry schema.",
        },
      ],
    },
  });

  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /versionImpact\.final/);
  assert.match(JSON.stringify(report.issues), /highest surface impact/);
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
