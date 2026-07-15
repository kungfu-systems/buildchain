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
import { artifactVerificationEnvelopeDigest } from "../packages/core/artifact-verification-envelope.js";
import {
  collectGitHubReleasePassport,
  createReleasePassport,
  explainReleasePassport,
  KFD2_TRUST_PROOF_CONTRACT,
  readJsonFromLocation,
  verifyReleasePassport,
} from "../packages/core/release-passport.js";
import {
  resolveKfd1Metadata,
  resolveKfd3Metadata,
  sha256File as sha256KfdFile,
} from "../packages/core/kfd-gate.js";
import { createBuildchainKfdClaimRegistry } from "../packages/core/buildchain-kfd-claims.js";
import { generateBuildchainKfdWitnesses } from "../scripts/generate-buildchain-kfd-witnesses.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

test("release passport records surface timestamp reproducibility policy", () => {
  const passport = createReleasePassport({
    repository: "kungfu-systems/buildchain",
    tag: "v2.8.8-alpha.7",
    sourceSha: "a".repeat(40),
    assets: [{ name: "buildchain.release.json", sha256: "b".repeat(64) }],
    release: { publishedAt: "2026-07-07T06:00:00Z" },
  });

  assert.equal(passport.surfaceTimestampPolicy.timestampPolicy, "ci-injected");
  assert.equal(passport.surfaceTimestampPolicy.publishedAt, "2026-07-07T06:00:00.000Z");
  assert.equal(passport.surfaceTimestampPolicy.sourceRevision, "a".repeat(40));
  assert.equal(passport.surfaceTimestampPolicy.reproducible, true);
  assert.equal(
    passport.surfaceTimestampPolicy.timestampPolicyDetails.timestampFieldsParticipateInArtifactDigest,
    true,
  );
});

test("release passport carries source-bound controller receipt references", () => {
  const sourceSha = "a".repeat(40);
  const reference = {
    controllerId: "build-lifecycle",
    planDigest: `sha256:${"b".repeat(64)}`,
    receiptDigest: `sha256:${"c".repeat(64)}`,
    sourceSha,
    runtimeSha: "d".repeat(40),
    status: "passed",
    artifact: "buildchain-controller-receipt",
  };
  const passport = createReleasePassport({
    repository: "kungfu-systems/buildchain",
    tag: "v2.12.5-alpha.1",
    sourceSha,
    controllerReceiptReferences: [reference],
  });

  assert.deepEqual(passport.controllerReceipts, [reference]);
  assert.throws(
    () => createReleasePassport({ tag: "v2.12.5-alpha.1", sourceSha: "e".repeat(40), controllerReceiptReferences: [reference] }),
    /source SHA mismatch/,
  );
});

test("release passport preserves a tree-equivalent RC controller source", () => {
  const builtSourceSha = "a".repeat(40);
  const promotionChannelSha = "e".repeat(40);
  const reference = {
    controllerId: "build-lifecycle",
    planDigest: `sha256:${"b".repeat(64)}`,
    receiptDigest: `sha256:${"c".repeat(64)}`,
    sourceSha: builtSourceSha,
    runtimeSha: "d".repeat(40),
    status: "passed",
    artifact: "buildchain-controller-receipt",
  };
  const passport = createReleasePassport({
    repository: "kungfu-systems/buildchain",
    tag: "v2.12.5-alpha.1",
    sourceSha: promotionChannelSha,
    release: {
      builtSourceSha,
      promotionChannelSha,
      treeEquivalent: true,
    },
    controllerReceiptReferences: [reference],
  });

  assert.deepEqual(passport.controllerReceipts, [reference]);
  assert.throws(
    () => createReleasePassport({
      tag: "v2.12.5-alpha.1",
      sourceSha: promotionChannelSha,
      release: { builtSourceSha, promotionChannelSha, treeEquivalent: false },
      controllerReceiptReferences: [reference],
    }),
    /source SHA mismatch/,
  );
});

test("KFD release gate metadata is statically bundled for action runtimes", () => {
  const source = fs.readFileSync(path.resolve("packages/core/kfd-gate.js"), "utf8");
  assert.match(source, /from "@kungfu-tech\/kfd\/package\.json" with \{ type: "json" \}/);
  assert.match(source, /from "@kungfu-tech\/kfd\/standards\.json" with \{ type: "json" \}/);
  assert.match(source, /from "@kungfu-tech\/kfd\/schemas\/kfd-2\/trust-taxonomy\.schema\.json" with \{ type: "json" \}/);
  assert.doesNotMatch(source, /\bcreateRequire\b/);
  assert.doesNotMatch(source, /\brequire\.resolve\b/);

  const metadata = resolveKfd1Metadata();
  assert.equal(metadata.package.name, "@kungfu-tech/kfd");
  assert.ok(metadata.schemaPaths.witness);
});

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
  supportLevel = "release",
  nonExhaustiveSurfaces = [],
} = {}) {
  const cwd = tempDir("kfd-3-gate");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "kungfu-package.tgz"), "package\n");
  const metadata = resolveKfd3Metadata({ requireSchemas: true });
  const riskDefinedBy = "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk";
  const normalizeFixtureRisk = (entry) => ({
    id: typeof entry === "string" ? entry : entry.id,
    definedBy: entry.definedBy || riskDefinedBy,
    riskType: entry.riskType || "partial-machine-coverage-risk",
    trustImpact: entry.trustImpact || "downgrade-warning",
    machineProvability: entry.machineProvability || "not-exhaustively-enumerable",
    agentAction: entry.agentAction || "semantic-review-required",
    reason: entry.reason || "Non-exhaustive surface remains outside the declared reverse audit boundary.",
    owner: entry.owner || "Kungfu",
    kind: entry.kind,
  });
  const normalizedNonExhaustiveSurfaces = nonExhaustiveSurfaces.map(normalizeFixtureRisk);
  const prebuildWitnessPath = writeJson(path.join(cwd, "kfd-3-prebuild.json"), {
    id: "kungfu-agent-bridge",
    standard: metadata.key,
    supportLevel,
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
        nonExhaustivelyEnumerableSurfaces: normalizedNonExhaustiveSurfaces,
      },
    },
    residualRisk: normalizedNonExhaustiveSurfaces,
    responsibility: {
      registryFactsOwner: "Kungfu",
      artifactVerificationOwner: "Kungfu agent verify",
      releasePassportProofOwner: "Buildchain",
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
    if (body && typeof body === "object" && body.status) {
      response.writeHead(body.status, body.headers || (body.location ? { location: body.location } : {}));
      response.end(body.body || "");
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

test("release passport JSON reader follows GitHub-style redirects", async () => {
  await withHttpFixture({
    "/latest/download/buildchain.release.json": {
      status: 302,
      location: "/download/v2.8.8/buildchain.release.json",
    },
    "/download/v2.8.8/buildchain.release.json": JSON.stringify({
      contract: "redirect-fixture",
      ok: true,
    }),
  }, async (baseUrl) => {
    const value = await readJsonFromLocation(`${baseUrl}/latest/download/buildchain.release.json`);
    assert.equal(value.contract, "redirect-fixture");
    assert.equal(value.ok, true);
  });
});

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

function createAnchoredPackagePassportBundle({
  tag = "v22.22.3-kf.3-alpha.16",
  internalTag = "v22.22.1-alpha.9",
  version = "22.22.3-kf.3-alpha.16",
  mainDigest = "sha256:package-digest",
  darwinDigest = "sha512-darwin",
} = {}) {
  const cwd = tempDir("anchored-package-passport");
  const publishEvidencePath = writeJson(path.join(cwd, "publish-evidence.json"), {
    schema: 1,
    version,
    channel: "alpha",
    source_sha: "a".repeat(40),
    release_sha: "b".repeat(40),
    release_material_sha: "b".repeat(40),
    publish_tooling_sha: "b".repeat(40),
    target_ref: "alpha/v22/v22.22",
    artifacts: [
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode",
        ref: version,
        digest: mainDigest,
      },
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode-darwin-arm64",
        ref: version,
        digest: darwinDigest,
      },
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode-linux-x64",
        ref: version,
        digest: "sha512-linux",
      },
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode-win32-x64",
        ref: version,
        digest: "sha512-windows",
      },
    ],
  });
  const packageSetPath = writeJson(path.join(cwd, "package-set.json"), {
    order: "platforms-first-main-last",
    registry: "https://registry.npmjs.org/",
    main: {
      name: "@kungfu-tech/libnode",
      version,
      distTag: "alpha",
      digest: mainDigest,
    },
    platforms: [
      {
        name: "@kungfu-tech/libnode-darwin-arm64",
        version,
        distTag: "alpha",
        digest: darwinDigest,
        platform: "darwin-arm64",
      },
      {
        name: "@kungfu-tech/libnode-linux-x64",
        version,
        distTag: "alpha",
        digest: "sha512-linux",
        platform: "linux-x64",
      },
      {
        name: "@kungfu-tech/libnode-win32-x64",
        version,
        distTag: "alpha",
        digest: "sha512-windows",
        platform: "win32-x64",
      },
    ],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    repository: "kungfu-systems/libnode",
    productName: "Libnode",
    tag,
    packageName: "@kungfu-tech/libnode",
    packageVersion: version,
    sourceSha: "a".repeat(40),
    outputDir: "release-passport",
    packageSetJson: packageSetPath,
    publishEvidenceJson: publishEvidencePath,
    transactionJson: JSON.stringify({
      transaction: {
        state: "complete",
        version,
        exact_tag: internalTag,
        release_sha: "b".repeat(40),
        release_material_sha: "b".repeat(40),
        publish_tooling_sha: "b".repeat(40),
        state_ref: "buildchain/release-state/22-22-3-kf-3-alpha-16",
      },
    }),
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v22/v22.22",
      publicTag: tag,
      internalTag,
      internalVersion: internalTag.replace(/^v/, ""),
      publishedVersion: version,
      versionLabel: version,
      releaseSha: "b".repeat(40),
      releaseMaterialSha: "b".repeat(40),
      publishToolingSha: "b".repeat(40),
      releaseStateRef: "refs/heads/buildchain/release-state/22-22-3-kf-3-alpha-16",
    }),
  });
  return collected.outputDir;
}

function serveBundleAt(releasePath, outputDir) {
  return Object.fromEntries(
    fs.readdirSync(outputDir)
      .filter((name) => fs.statSync(path.join(outputDir, name)).isFile())
      .map((name) => [`${releasePath}/${name}`, fs.readFileSync(path.join(outputDir, name))]),
  );
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

  const assessmentKey = artifactVerificationEnvelopeDigest({
    claim: "artifact-admission",
    purpose: "workspace-install",
  });
  const kfdReport = {
    assessment_key: assessmentKey,
    purpose: "workspace-install",
    state: "fresh",
    query_proof_root: `sha256:${"b".repeat(64)}`,
    contract_world: { root: `sha256:${"c".repeat(64)}` },
    policy: { root: `sha256:${"d".repeat(64)}` },
    fact_surfaces: [{ root: `sha256:${"e".repeat(64)}` }],
  };
  kfdReport.report_hash = artifactVerificationEnvelopeDigest(kfdReport);
  const sealed = await verifyArtifactPassport({
    subject: fixture.artifactPath,
    passportLocation: fixture.passportPath,
    verificationEnvelope: {
      issuedAt: 100,
      expiresAt: 200,
      revocation: {
        status: "active",
        revoked: false,
        checkedAt: 150,
        source: "buildchain.release/revocations/v1",
        root: artifactVerificationEnvelopeDigest({ status: "active", checkedAt: 150 }),
      },
      bindings: {
        schema: "kungfu.kfx-trust-inputs/v1",
        packageRoot: `sha256:${"0".repeat(64)}`,
        sourceRoot: `sha256:${"1".repeat(64)}`,
        dependencyRoot: `sha256:${"2".repeat(64)}`,
        buildPlanRoot: `sha256:${"3".repeat(64)}`,
        toolchainRoot: `sha256:${"4".repeat(64)}`,
        artifactRoot: report.subject.digest,
        qualificationRoot: kfdReport.report_hash,
        verifierRoot: `sha256:${"7".repeat(64)}`,
        issuer: "buildchain.libkungfu.dev",
        publisher: "kungfu-systems",
        contractVersion: "buildchain.release/v1",
      },
      kfdAssessment: {
        schema: "kungfu.trust.assessment/v1",
        state: "fresh",
        assessment_key: assessmentKey,
        report: kfdReport,
      },
    },
  });
  assert.equal(sealed.ok, true);
  assert.equal(sealed.envelope.contract, "kungfu-buildchain-artifact-verification-envelope");
  assert.equal(sealed.bindings.artifactRoot, report.subject.digest);
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

test("artifact passport discovery prefers npm package public release tags", async () => {
  const releasePath = "/kungfu-systems/libnode/releases/download/v22.22.3-kf.3-alpha.16";
  const outputDir = createAnchoredPackagePassportBundle();

  await withHttpFixture(serveBundleAt(releasePath, outputDir), async (baseUrl) => {
    const discovery = await verifyArtifactPassport({
      subject: "npm:@kungfu-tech/libnode@22.22.3-kf.3-alpha.16",
      repository: "kungfu-systems/libnode",
      githubReleaseBaseUrl: baseUrl,
      subjectDigest: "sha256:package-digest",
    });
    assert.equal(discovery.ok, true);
    assert.equal(discovery.discovery.method, "github-release-default");
    assert.equal(discovery.discovery.details.tag, "v22.22.3-kf.3-alpha.16");
  });
});

test("artifact passport verification resolves npm registry integrity for package-set subjects", async () => {
  const releasePath = "/kungfu-systems/libnode/releases/download/v22.22.3-kf.3-alpha.18";
  const version = "22.22.3-kf.3-alpha.18";
  const mainIntegrity = "sha512-bGliLm5vZGUtbWFpbg==";
  const darwinIntegrity = "sha512-bGliLm5vZGUtZGFyd2lu";
  const outputDir = createAnchoredPackagePassportBundle({
    tag: `v${version}`,
    version,
    mainDigest: mainIntegrity,
    darwinDigest: darwinIntegrity,
  });

  await withHttpFixture({
    ...serveBundleAt(releasePath, outputDir),
    "/registry/@kungfu-tech/libnode": JSON.stringify({
      versions: {
        [version]: {
          dist: {
            integrity: mainIntegrity,
            tarball: "https://registry.example.invalid/@kungfu-tech/libnode/-/libnode.tgz",
          },
        },
      },
    }),
    "/registry/@kungfu-tech/libnode-darwin-arm64": JSON.stringify({
      versions: {
        [version]: {
          dist: {
            integrity: darwinIntegrity,
            tarball: "https://registry.example.invalid/@kungfu-tech/libnode-darwin-arm64/-/libnode-darwin-arm64.tgz",
          },
        },
      },
    }),
  }, async (baseUrl) => {
    const mainReport = await verifyArtifactPassport({
      subject: `npm:@kungfu-tech/libnode@${version}`,
      repository: "kungfu-systems/libnode",
      githubReleaseBaseUrl: baseUrl,
      npmRegistryBaseUrl: `${baseUrl}/registry/`,
    });
    assert.equal(mainReport.ok, true);
    assert.equal(mainReport.subject.digest, mainIntegrity);
    assert.equal(mainReport.subject.npm.digestResolution, "resolved");
    assert.ok(["passport.artifacts", "publish-evidence.artifacts", "packageSet"].includes(mainReport.match.source));

    const platformReport = await verifyArtifactPassport({
      subject: `npm:@kungfu-tech/libnode-darwin-arm64@${version}`,
      repository: "kungfu-systems/libnode",
      githubReleaseBaseUrl: baseUrl,
      npmRegistryBaseUrl: `${baseUrl}/registry/`,
    });
    assert.equal(platformReport.ok, true);
    assert.equal(platformReport.subject.digest, darwinIntegrity);
    assert.ok(["passport.artifacts", "publish-evidence.artifacts", "packageSet"].includes(platformReport.match.source));
  });
});

test("artifact passport discovery keeps explicit internal exact tag compatibility", async () => {
  const releasePath = "/kungfu-systems/libnode/releases/download/v22.22.1-alpha.9";
  const outputDir = createAnchoredPackagePassportBundle();

  await withHttpFixture(serveBundleAt(releasePath, outputDir), async (baseUrl) => {
    const report = await verifyArtifactPassport({
      subject: "npm:@kungfu-tech/libnode@22.22.3-kf.3-alpha.16",
      repository: "kungfu-systems/libnode",
      tag: "v22.22.1-alpha.9",
      githubReleaseBaseUrl: baseUrl,
      subjectDigest: "sha256:package-digest",
    });
    assert.equal(report.ok, true);
    assert.equal(report.discovery.details.tag, "v22.22.1-alpha.9");
    assert.equal(
      report.discovery.attempts.some((attempt) =>
        attempt.method === "github-release-default" &&
        attempt.status === "miss" &&
        attempt.details?.tag === "v22.22.3-kf.3-alpha.16"),
      true,
    );
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
    tag: "v22.22.3-kf.3-alpha.7",
    packageVersion: "22.22.3-kf.3-alpha.7",
    releaseExtra: {
      channel: "alpha",
      targetRef: "alpha/v22/v22.22",
      publicTag: "v22.22.3-kf.3-alpha.7",
      internalTag: "v22.22.1-alpha.1",
      internalVersion: "22.22.1-alpha.1",
      publishedVersion: "22.22.3-kf.3-alpha.7",
      versionLabel: "22.22.3-kf.3-alpha.7",
    },
  });
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));

  assert.equal(passport.release.tag, "v22.22.3-kf.3-alpha.7");
  assert.equal(passport.release.publicTag, "v22.22.3-kf.3-alpha.7");
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

test("release passport accepts cwd-relative KFD witness path inputs", async () => {
  const { cwd, assetsDir, witnessPath, metadata } = createKfdWitnessFixture();
  const relativeWitnessPath = ".buildchain/kfd/kfd-1/contract-world.witness.json";
  const resolvedWitnessPath = path.join(cwd, relativeWitnessPath);
  fs.mkdirSync(path.dirname(resolvedWitnessPath), { recursive: true });
  fs.copyFileSync(witnessPath, resolvedWitnessPath);
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
    kfd1WitnessJsons: [relativeWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, true);
  assert.equal(passport[metadata.key].status, "passed");
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

test("release passport supports KFD repository self contract verification", async () => {
  const cwd = tempDir("kfd-1-self-contract");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "kfd-package.tgz"), "package\n");
  const metadata = resolveKfd1Metadata();
  const surfaceSpecs = [
    {
      group: "docs",
      id: "docs:kfd-1",
      sourcePath: "docs/KFD-1.md",
      artifactPath: "package/docs/KFD-1.md",
      content: "# KFD-1\n",
    },
    {
      group: "schemas",
      id: "schema:kfd-1-witness",
      sourcePath: "schemas/kfd-1-witness.schema.json",
      artifactPath: "package/schemas/kfd-1-witness.schema.json",
      content: "{\"type\":\"object\"}\n",
    },
    {
      group: "standardsMetadata",
      id: "metadata:standards",
      sourcePath: "registry.json",
      artifactPath: "package/registry.json",
      content: "{\"standards\":[\"kfd-1\"]}\n",
    },
    {
      group: "packageExports",
      id: "export:kfd-metadata",
      sourcePath: "package.exports.json",
      artifactPath: "package/package.exports.json",
      content: "{\"./metadata\":\"./dist/metadata.js\"}\n",
    },
    {
      group: "siteConsumptionContracts",
      id: "site:kfd-standards-index",
      sourcePath: "site/standards.json",
      artifactPath: "package/dist/site/standards.json",
      content: "{\"kfd\":true}\n",
    },
  ];
  const standardContract = {
    id: "kfd-standard-contract",
    path: "registry.json",
    docs: [],
    schemas: [],
    standardsMetadata: [],
    packageExports: [],
    siteConsumptionContracts: [],
  };
  for (const spec of surfaceSpecs) {
    const sourceFile = path.join(cwd, spec.sourcePath);
    const artifactFile = path.join(assetsDir, spec.artifactPath);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.writeFileSync(sourceFile, spec.content);
    fs.writeFileSync(artifactFile, spec.content);
    const sha256 = sha256KfdFile(sourceFile);
    standardContract[spec.group].push({
      id: spec.id,
      sourcePath: spec.sourcePath,
      sourceSha256: sha256,
      artifactPath: spec.artifactPath,
      expectedSha256: sha256,
    });
  }
  standardContract.sha256 = sha256KfdFile(path.join(cwd, "registry.json"));
  const witnessPath = writeJson(path.join(cwd, "kfd-1-self-contract.json"), {
    id: "kfd-standard-contract",
    standard: metadata.key,
    source: {
      repo: "kungfu-systems/kfd",
      ref: "a".repeat(40),
    },
    contractWorld: {
      id: "kfd-standard-contract",
      schemaId: metadata.schemaIds.contractWorld,
      digest: `sha256:${standardContract.sha256}`,
      owner: "KFD maintainers",
      selfHosted: true,
    },
    standardContract,
    selfHostingBoundary: {
      mode: "self-hosted-standard-contract",
      sourceScope: "KFD source standards, schemas, package exports, and site contracts",
      artifactScope: "npm package and site-consumption payload",
      residualRisk: [
        {
          id: "prose-interpretation",
          definedBy: "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk",
          riskType: "natural-language-semantic-risk",
          trustImpact: "downgrade-warning",
          machineProvability: "not-machine-verifiable",
          agentAction: "semantic-review-required",
          reason: "Natural-language standard interpretation remains reviewed but not byte-enumerable.",
          owner: "KFD maintainers",
        },
      ],
    },
    responsibility: {
      sourceContractOwner: "KFD maintainers",
      artifactVerificationOwner: "Buildchain KFD-1 gate",
      releasePassportProofOwner: "Buildchain",
    },
  });

  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "c".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd1WitnessJsons: [witnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const world = passport[metadata.key].contractWorlds[0];

  assert.equal(report.ok, true);
  assert.equal(passport[metadata.key].status, "passed");
  assert.equal(passport[metadata.key].selfContractVerification.result, "pass");
  assert.equal(passport[metadata.key].selfContractVerification.selfHosted, true);
  assert.equal(passport["kfd-2"].status, "downgraded");
  assert.equal(passport["kfd-2"].claims.some((claim) => claim.id === "kfd-1:kfd-standard-contract"), true);
  assert.equal(world.result, "passed");
  assert.equal(world.sourceVerification.required, true);
  assert.equal(world.sourceVerification.status, "passed");
  assert.equal(world.sourceVerification.surfaces.length, 5);
  assert.equal(world.artifactVerification.surfaces.length, 5);
  assert.equal(world.sourceHashes.sha256.length, 64);
  assert.equal(world.artifactHashes.sha256.length, 64);
  assert.equal(world.standardContract.schemaId, metadata.schemaIds.contractWorld);
  assert.equal(world.selfHostingBoundary.mode, "self-hosted-standard-contract");
  assert.equal(world.selfHostingBoundary.residualRisk[0].id, "prose-interpretation");
  assert.equal(world.responsibility.sourceContractOwner, "KFD maintainers");
  assert.equal(world.responsibility.releasePassportProofOwner, "Buildchain");
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
  assert.equal(passport[metadata.key].releaseStatus, "enforced");
  assert.equal(passport[metadata.key].trustProof.result, "pass");
  assert.equal(passport[metadata.key].trustProof.audited, true);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].trustProof.result, "pass");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].trustProof.releaseStatus, "enforced");
  assert.equal(
    passport[metadata.key].collaborationInterfaces[0].trustProof.statement,
    "No unclassified reachable surface within the declared audit boundary.",
  );
  assert.equal(passport[metadata.key].collaborationInterfaces[0].declaredCapabilityVerification.result, "passed");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].reverseAudit.status, "passed");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].witnessEvidence.prebuild.path.endsWith("kfd-3-prebuild.json"), true);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].witnessEvidence.prebuild.sha256.length, 64);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].witnessEvidence.prebuild.canonicalSha256.length, 64);
  assert.equal(passport[metadata.key].collaborationInterfaces[0].responsibility.registryFactsOwner, "Kungfu");
  assert.equal(passport.evidence.kfd3, metadata.key);
});

test("release passport supports KFD repository self-verification surfaces", async () => {
  const cwd = tempDir("kfd-3-self-verification");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "kfd-package.tgz"), "package\n");
  const metadata = resolveKfd3Metadata({ requireSchemas: true });
  const riskDefinedBy = "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk";
  const semanticRisk = {
    id: "human-language-interpretation",
    definedBy: riskDefinedBy,
    riskType: "natural-language-semantic-risk",
    trustImpact: "downgrade-warning",
    machineProvability: "not-machine-verifiable",
    agentAction: "semantic-review-required",
    reason: "Natural-language standard interpretation cannot be fully enumerated from package bytes.",
    owner: "KFD maintainers",
  };
  const groupedSurfaces = {
    docs: [{ id: "docs:kfd-3", sourcePath: "docs/KFD-3.md" }],
    schemas: [{ id: "schema:kfd-3-witness", sourcePath: "schemas/kfd-3-witness.schema.json" }],
    standardsMetadata: [{ id: "metadata:registry", sourcePath: "registry.json" }],
    packageExports: [{ id: "export:kfd-metadata", sourcePath: "package.json#exports" }],
    siteConsumptionContracts: [{ id: "site:kfd-standards-index", sourcePath: "dist/site/standards.json" }],
  };
  const prebuildWitnessPath = writeJson(path.join(cwd, "kfd-3-prebuild.json"), {
    id: "kfd-repository",
    standard: metadata.key,
    supportLevel: "release",
    source: {
      repo: "kungfu-systems/kfd",
      ref: "a".repeat(40),
    },
    sourceRegistry: {
      id: "KFD",
      path: "registry.json",
      sha256: "1".repeat(64),
    },
    collaborationInterfaceDigest: "sha256:kfd-self-verification",
    collaborationInterface: {
      schemaVersion: 1,
      contract: "kfd-3-collaboration-interface",
      product: {
        name: "KFD",
        repository: "kungfu-systems/kfd",
      },
      participants: [
        { id: "human", kind: "human" },
        { id: "agent", kind: "agent" },
      ],
      ...groupedSurfaces,
      closure: {
        classificationMode: "closed-world",
        unclassifiedEntrypointsPolicy: "fail",
        nonExhaustivelyEnumerableSurfaces: [
          {
            ...semanticRisk,
            kind: "semantic-risk",
            reason: "Natural-language standard interpretation is reviewed but not exhaustively enumerable.",
          },
        ],
      },
    },
    residualRisk: [semanticRisk],
    responsibility: {
      registryFactsOwner: "KFD",
      artifactVerificationOwner: "KFD package self-verification",
      releasePassportProofOwner: "Buildchain",
    },
  });
  const artifactWitnessPath = writeJson(path.join(cwd, "kfd-3-artifact.json"), {
    id: "kfd-repository",
    standard: metadata.key,
    collaborationInterface: {
      schemaId: metadata.schemaIds.collaborationInterface,
      digest: "sha256:kfd-self-verification",
    },
    sourceRegistry: {
      id: "KFD",
      path: "registry.json",
      sha256: "1".repeat(64),
    },
    artifact: {
      name: "kfd-package.tgz",
      path: "dist/kfd-package.tgz",
      digest: `sha256:${"2".repeat(64)}`,
    },
    ...groupedSurfaces,
    verifier: {
      name: "kfd self-verification",
    },
  });

  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const kfd3 = passport[metadata.key];
  const proof = kfd3.collaborationInterfaces[0];

  assert.equal(report.ok, true);
  assert.equal(kfd3.status, "passed");
  assert.equal(kfd3.releaseStatus, "audited");
  assert.equal(proof.comparison.declaredShippedPublicSurfaceCount, 5);
  assert.deepEqual(
    proof.declaredSurfaces.map((surface) => surface.kind).sort(),
    ["documentation", "package-export", "schema", "site-consumption-contract", "standards-metadata"],
  );
  assert.equal(proof.reverseAudit.status, "passed");
  assert.equal(proof.reverseAudit.nonExhaustivelyEnumerableSurfaces[0].id, "human-language-interpretation");
  assert.equal(proof.residualRisk[0].owner, "KFD maintainers");
  assert.equal(proof.responsibility.registryFactsOwner, "KFD");
  assert.equal(proof.responsibility.releasePassportProofOwner, "Buildchain");
  assert.equal(proof.witnessEvidence.prebuild.canonicalSha256.length, 64);
  assert.equal(proof.witnessEvidence.artifact.canonicalSha256.length, 64);
  assert.equal(kfd3.trustProof.result, "pass");
  assert.equal(passport["kfd-2"].status, "downgraded");
  const kfd2TrustClaim = passport["kfd-2"].claims.find((claim) => claim.id === "kfd-3:kfd-repository");
  assert.ok(kfd2TrustClaim);
  assert.equal(kfd2TrustClaim.status, "downgraded");
  assert.equal(kfd2TrustClaim.trustProof.contract, KFD2_TRUST_PROOF_CONTRACT);
  assert.equal(kfd2TrustClaim.trustProof.result, "downgraded");
  assert.equal(kfd2TrustClaim.trustProof.witnessHashes.prebuildWitnessSha256, proof.preBuildWitnessSha256);
  assert.equal(kfd2TrustClaim.trustProof.witnessHashes.artifactWitnessSha256, proof.artifactWitnessSha256);
  assert.equal(kfd2TrustClaim.trustProof.declaredCapabilityVerification.result, "passed");
  assert.equal(kfd2TrustClaim.trustProof.reverseAudit.status, "passed");
  assert.equal(kfd2TrustClaim.trustProof.reverseAuditBoundary.nonExhaustivelyEnumerableSurfaces[0].id, "human-language-interpretation");
  assert.equal(kfd2TrustClaim.trustProof.residualRisk[0].owner, "KFD maintainers");
  assert.equal(kfd2TrustClaim.trustProof.responsibility.releasePassportProofOwner, "Buildchain");
});

test("Buildchain self KFD claims generate enforceable release passport evidence", async () => {
  const root = process.cwd();
  const outputDir = tempDir("buildchain-self-kfd");
  const generated = generateBuildchainKfdWitnesses({
    cwd: root,
    outputDir,
    sourceSha: "e".repeat(40),
    emitOutputs: false,
  });
  assert.match(generated.outputs["kfd-1-witness-jsons"], /kfd-1\/contract-world\.witness\.json$/);
  assert.match(generated.outputs["kfd-2-claim-jsons"], /kfd-2\/claims\//);
  assert.match(generated.outputs["kfd-3-prebuild-witness-jsons"], /kfd-3\/collaboration-interface\.prebuild\.json$/);
  assert.match(generated.outputs["kfd-3-artifact-witness-jsons"], /kfd-3\/collaboration-interface\.artifact\.json$/);
  const output = (name) => path.resolve(root, generated.outputs[name]);
  const outputList = (name) => String(generated.outputs[name] || "")
    .split(",")
    .filter(Boolean)
    .map((entry) => path.resolve(root, entry));
  const kfd1Metadata = resolveKfd1Metadata();
  const kfd3Metadata = resolveKfd3Metadata({ requireSchemas: true });
  const collected = collectGitHubReleasePassport({
    cwd: root,
    tag: "v2.8.2-alpha.0",
    repository: "kungfu-systems/buildchain",
    productName: "Buildchain",
    sourceSha: "e".repeat(40),
    assetsDir: "dist/site",
    outputDir: path.join(outputDir, "release-passport"),
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v2/v2.8",
    }),
    kfd1WitnessJsons: [output("kfd-1-witness-jsons")],
    kfd2ClaimJsons: outputList("kfd-2-claim-jsons"),
    kfd3PrebuildWitnessJsons: [output("kfd-3-prebuild-witness-jsons")],
    kfd3ArtifactWitnessJsons: [output("kfd-3-artifact-witness-jsons")],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const kfd1 = passport[kfd1Metadata.key];
  const kfd3 = passport[kfd3Metadata.key];
  const kfd2 = passport["kfd-2"];

  assert.equal(report.ok, true);
  assert.equal(kfd1.status, "passed");
  assert.equal(kfd1.selfContractVerification.selfHosted, true);
  assert.equal(kfd1.contractWorlds[0].sourceVerification.status, "passed");
  assert.equal(kfd1.contractWorlds[0].artifactVerification.status, "passed");
  assert.equal(kfd3.status, "passed");
  assert.equal(kfd3.releaseStatus, "enforced");
  assert.equal(kfd3.trustProof.result, "pass");
  assert.equal(kfd3.collaborationInterfaces[0].declaredCapabilityVerification.result, "passed");
  assert.equal(kfd3.collaborationInterfaces[0].reverseAudit.status, "passed");
  assert.equal(kfd2.status, "passed");
  assert.equal(kfd2.claims.some((claim) => claim.id === "claim:buildchain-agent-first-source-of-truth"), true);
  assert.equal(kfd2.claims.every((claim) => claim.missingBindings.length === 0), true);
  assert.ok(kfd3.collaborationInterfaces[0].declaredSurfaces.some((surface) => surface.id === "site:dist/site/kfd-claims.json"));
  assert.ok(kfd3.collaborationInterfaces[0].declaredSurfaces.some((surface) => surface.id === "export:./buildchain-kfd-claims"));
});

test("binary release passport can merge authoritative Buildchain KFD release-state passport", async () => {
  const root = process.cwd();
  const outputDir = tempDir("buildchain-kfd-base-passport");
  const sourceSha = "f".repeat(40);
  const controllerReceiptReference = {
    controllerId: "build-lifecycle",
    planDigest: `sha256:${"a".repeat(64)}`,
    receiptDigest: `sha256:${"b".repeat(64)}`,
    sourceSha,
    runtimeSha: sourceSha,
    status: "passed",
    artifact: "buildchain-controller-receipt",
  };
  const generated = generateBuildchainKfdWitnesses({
    cwd: root,
    outputDir,
    sourceSha,
    emitOutputs: false,
  });
  const output = (name) => path.resolve(root, generated.outputs[name]);
  const outputList = (name) => String(generated.outputs[name] || "")
    .split(",")
    .filter(Boolean)
    .map((entry) => path.resolve(root, entry));
  const authoritative = collectGitHubReleasePassport({
    cwd: root,
    tag: "v2.8.2",
    repository: "kungfu-systems/buildchain",
    productName: "Buildchain",
    sourceSha,
    assetsDir: "dist/site",
    outputDir: path.join(outputDir, "release-state-passport"),
    releaseJsonExtra: JSON.stringify({
      channel: "release",
      targetRef: "release/v2/v2.8",
      releaseStateSha: "1".repeat(40),
    }),
    impactJson: JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      versionImpact: { final: "minor", source: "test", rationale: "KFD release-state passport base." },
      surfaceImpacts: [
        { id: "kfd-release-state", impact: "minor", class: "release-passport", rationale: "KFD evidence is inherited from durable release state." },
      ],
      classification: "minor",
    }),
    kfd1WitnessJsons: [output("kfd-1-witness-jsons")],
    kfd2ClaimJsons: outputList("kfd-2-claim-jsons"),
    kfd3PrebuildWitnessJsons: [output("kfd-3-prebuild-witness-jsons")],
    kfd3ArtifactWitnessJsons: [output("kfd-3-artifact-witness-jsons")],
    controllerReceiptReferences: [controllerReceiptReference],
  });
  const binaryDir = path.join(outputDir, "dist", "binary");
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(path.join(binaryDir, "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "linux-binary\n");
  const collected = collectGitHubReleasePassport({
    cwd: root,
    tag: "v2.8.2",
    repository: "kungfu-systems/buildchain",
    productName: "Buildchain",
    sourceSha: "2".repeat(40),
    assetsDir: binaryDir,
    outputDir: path.join(outputDir, "binary-passport"),
    basePassportJson: path.join(authoritative.outputDir, "buildchain.release.json"),
    requireBaseKfd: true,
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, true);
  assert.equal(passport.evidence.kfd1, "kfd-1");
  assert.equal(passport.evidence.kfd2, "kfd-2");
  assert.equal(passport.evidence.kfd3, "kfd-3");
  assert.equal(passport["kfd-1"].status, "passed");
  assert.equal(passport["kfd-2"].status, "passed");
  assert.equal(passport["kfd-3"].status, "passed");
  assert.equal(passport.release.releaseStateSha, "1".repeat(40));
  assert.deepEqual(passport.controllerReceipts, [controllerReceiptReference]);
  assert.ok(passport.artifacts.some((artifact) => artifact.name === "buildchain-x86_64-unknown-linux-gnu.tar.gz"));
});

test("version-bound impact remains authoritative in the public release asset", () => {
  const cwd = tempDir("version-bound-public-impact");
  const surfaceImpacts = [
    {
      id: "release-impact-version-binding",
      impact: "patch",
      class: "release-evidence",
      rationale: "The public impact asset stays bound to the published version.",
      source: "release-impact.json",
    },
  ];
  const basePassportPath = writeJson(path.join(cwd, "release-candidate-passport.json"), {
    release: { publishedVersion: "2.11.10-alpha.1", targetRef: "alpha/v2/v2.11" },
    versionImpact: { final: "patch", source: "buildchain-version-state", rationale: "Version-bound impact." },
    surfaceImpacts,
    classification: "unknown",
    summary: "No release impact summary was supplied.",
  });
  const impactPath = writeJson(path.join(cwd, "release-impact.json"), {
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { version: "2.11.10-alpha.1", line: "v2.11" },
    versionImpact: { final: "patch", source: "buildchain-version-state", rationale: "Version-bound impact." },
    surfaceImpacts,
    classification: "patch",
    breaking: false,
    security: false,
    migrationRequired: false,
    summary: "Buildchain public impact evidence is version-bound.",
  });
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain.tgz"), "release-bytes\n");

  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v2.11.10-alpha.1",
    line: "v2.11",
    repository: "kungfu-systems/buildchain",
    sourceSha: "a".repeat(40),
    packageVersion: "2.11.10-alpha.1",
    assetsDir,
    outputDir: "release-passport",
    basePassportJson: basePassportPath,
    impactJson: impactPath,
  });
  const impact = JSON.parse(fs.readFileSync(path.join(collected.outputDir, "impact.json"), "utf8"));

  assert.equal(impact.release.version, "2.11.10-alpha.1");
  assert.equal(impact.release.line, "v2.11");
  assert.equal(impact.classification, "patch");
  assert.equal(impact.summary, "Buildchain public impact evidence is version-bound.");
  assert.equal(collected.checkReport.ok, true, JSON.stringify(collected.checkReport.issues));
});

test("release passport collection bundles publish evidence as a sibling audit asset", async () => {
  const cwd = tempDir("release-passport-flat-publish-evidence");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain.tgz"), "package-bytes\n");
  const publishEvidencePath = writeJson(path.join(cwd, ".buildchain", "release-evidence", "v1.2.3-alpha.4", "evidence.json"), {
    schema: 1,
    version: "1.2.3-alpha.4",
    channel: "alpha",
    source_sha: "a".repeat(40),
    release_sha: "b".repeat(40),
    target_ref: "alpha/v1/v1.2",
    release_material_sha: "b".repeat(40),
    publish_tooling_sha: "b".repeat(40),
    artifacts: [
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.2.3-alpha.4",
        digest: "sha512-test",
      },
    ],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.2.3-alpha.4",
    repository: "kungfu-systems/buildchain",
    productName: "Buildchain",
    sourceSha: "a".repeat(40),
    assetsDir,
    outputDir: path.join(cwd, ".buildchain", "release-passport"),
    publishEvidenceJson: publishEvidencePath,
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.2",
      releaseSha: "b".repeat(40),
      releaseMaterialSha: "b".repeat(40),
      publishToolingSha: "b".repeat(40),
    }),
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport.evidence.publishEvidence, "evidence.json");
  assert.equal(fs.existsSync(path.join(collected.outputDir, "evidence.json")), true);
  assert.equal(report.ok, true);
});

test("release passport preserves a five-image mixed built and reused provenance family", async () => {
  const cwd = tempDir("release-passport-oci-provenance");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "family.json"), "{}\n");
  const version = "1.2.0-alpha.3";
  const sourceSha = "a".repeat(40);
  const releaseSha = "b".repeat(40);
  const names = ["base-linux", "node24-pnpm", "latex-pdf-builder", "native-linux-x64", "kungfu-verify"];
  const artifacts = names.map((name, index) => {
    const action = index === 2 ? "built" : "reused";
    const digest = `sha256:image-${index}`;
    const contentIsCurrent = action === "built";
    const artifact = {
      group: "image",
      kind: "oci",
      name: `ghcr.io/kungfu-systems/${name}`,
      ref: version,
      digest,
      action,
      platform: "linux/amd64",
      contract_major: 1,
      content: {
        version: contentIsCurrent ? version : "1.1.9",
        ref: contentIsCurrent ? version : "1.1.9",
        source_sha: contentIsCurrent ? sourceSha : "c".repeat(40),
        material_sha: contentIsCurrent ? releaseSha : "d".repeat(40),
      },
      release: {
        version,
        ref: version,
        target_ref: "alpha/v1/v1.2",
        source_sha: sourceSha,
        material_sha: releaseSha,
      },
      verification: {
        public_manifest: true,
        ref: version,
        digest,
        platform: "linux/amd64",
        contract_major: 1,
        evidence: `registry-inspect-${index}.json`,
        smoke: {
          policy: "manifest-contract",
          passed: true,
          evidence: `smoke-${index}.json`,
        },
      },
    };
    if (index > 0) {
      artifact.parent_digest = `sha256:image-${index - 1}`;
      artifact.verification.parent_digest = artifact.parent_digest;
    }
    return artifact;
  });
  const publishEvidencePath = writeJson(path.join(cwd, "publish-evidence.json"), {
    schema: 1,
    version,
    channel: "alpha",
    source_sha: sourceSha,
    release_sha: releaseSha,
    target_ref: "alpha/v1/v1.2",
    release_material_sha: releaseSha,
    publish_tooling_sha: releaseSha,
    artifacts,
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: `v${version}`,
    repository: "kungfu-systems/build-images",
    productName: "Build Images",
    sourceSha,
    assetsDir,
    outputDir: "release-passport",
    publishEvidenceJson: publishEvidencePath,
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.2",
      releaseSha,
      releaseMaterialSha: releaseSha,
      publishToolingSha: releaseSha,
    }),
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const publishedFamily = passport.artifacts.filter((artifact) => artifact.kind === "oci");

  assert.equal(collected.checkReport.ok, true, JSON.stringify(collected.checkReport.issues));
  assert.deepEqual(publishedFamily.map((artifact) => artifact.action), [
    "reused", "reused", "built", "reused", "reused",
  ]);
  assert.equal(publishedFamily[0].content.material_sha, "d".repeat(40));
  assert.equal(publishedFamily[2].release.material_sha, releaseSha);
  assert.equal(publishedFamily[4].verification.smoke.passed, true);

  const drifted = JSON.parse(fs.readFileSync(path.join(collected.outputDir, "evidence.json"), "utf8"));
  drifted.artifacts[0].release.material_sha = "e".repeat(40);
  writeJson(path.join(collected.outputDir, "evidence.json"), drifted);
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /artifact provenance mismatch|release\.material_sha/);
});

test("Buildchain source KFD claim registry is stable across semver version-state bumps", () => {
  const cwd = tempDir("buildchain-self-kfd-stable-claims");
  writeJson(path.join(cwd, "package.json"), {
    name: "@kungfu-tech/buildchain",
    version: "2.8.2-alpha.0",
    type: "module",
    repository: { url: "https://github.com/kungfu-systems/buildchain" },
    exports: {
      ".": "./packages/core/index.js",
      "./buildchain-kfd-claims": "./packages/core/buildchain-kfd-claims.js",
      "./site/kfd-claims.json": "./dist/site/kfd-claims.json",
    },
  });
  const before = createBuildchainKfdClaimRegistry({ root: cwd });
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  packageJson.version = "2.8.2-alpha.1";
  writeJson(packageJsonPath, packageJson);
  const after = createBuildchainKfdClaimRegistry({ root: cwd });
  assert.deepEqual(after, before);
  assert.equal(before.source.version, undefined);
  assert.equal(before.runtimeContract.contractDigest, undefined);
});

test("release passport fails closed when KFD self-verification artifact exposes undeclared package or site surfaces", async () => {
  const cwd = tempDir("kfd-3-self-verification-fail");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "kfd-package.tgz"), "package\n");
  const metadata = resolveKfd3Metadata({ requireSchemas: true });
  const prebuildWitnessPath = writeJson(path.join(cwd, "kfd-3-prebuild.json"), {
    id: "kfd-repository",
    standard: metadata.key,
    sourceRegistry: {
      id: "KFD",
      path: "registry.json",
      sha256: "1".repeat(64),
    },
    collaborationInterface: {
      packageExports: [{ id: "export:kfd-metadata" }],
      siteConsumptionContracts: [{ id: "site:kfd-standards-index" }],
      closure: {
        classificationMode: "closed-world",
        unclassifiedEntrypointsPolicy: "fail",
      },
    },
  });
  const artifactWitnessPath = writeJson(path.join(cwd, "kfd-3-artifact.json"), {
    id: "kfd-repository",
    standard: metadata.key,
    packageExports: [
      { id: "export:kfd-metadata" },
      { id: "export:undocumented-internal" },
    ],
    siteConsumptionContracts: [
      { id: "site:kfd-standards-index" },
      { id: "site:undocumented-feed" },
    ],
  });

  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd3PrebuildWitnessJsons: [prebuildWitnessPath],
    kfd3ArtifactWitnessJsons: [artifactWitnessPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const proof = passport[metadata.key].collaborationInterfaces[0];

  assert.equal(report.ok, false);
  assert.deepEqual(proof.comparison.unclassifiedArtifactPublic, [
    "export:undocumented-internal",
    "site:undocumented-feed",
  ]);
  assert.equal(proof.reverseAudit.status, "failed");
  assert.equal(proof.trustProof.result, "fail");
});

test("release passport fails closed when a public KFD-2 release claim is unbound", async () => {
  const { cwd, assetsDir } = createKfdWitnessFixture();
  const claimPath = writeJson(path.join(cwd, "kfd-2-claim.json"), {
    id: "claim:public-kfd-release-trust",
    public: true,
    claim: "KFD release is fully machine-verifiable.",
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd2ClaimJsons: [claimPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport["kfd-2"].status, "failed");
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /declared-sources|machine-readable-evidence|kfd-2/);
});

test("release passport downgrades a public KFD-2 claim that is machine-bound but prose-supported", async () => {
  const { cwd, assetsDir, actualSha256 } = createKfdWitnessFixture();
  const claimPath = writeJson(path.join(cwd, "kfd-2-claim.json"), {
    id: "claim:kfd-prose-explanation",
    public: true,
    claim: "KFD release notes explain the trust boundary.",
    support: "prose",
    sourceBindings: [{ path: "docs/KFD-2.md", sha256: actualSha256 }],
    machineEvidence: [{ path: "release-notes.md", sha256: actualSha256 }],
    hashes: { sourceSha256: actualSha256, evidenceSha256: actualSha256 },
    artifacts: [{ name: "generic.schema", path: "config.schema.json", sha256: actualSha256 }],
    verification: { result: "passed" },
    auditBoundary: { scope: "release notes" },
    responsibility: { owner: "KFD maintainers" },
    residualRisk: [],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd2ClaimJsons: [claimPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport["kfd-2"].status, "downgraded");
  assert.equal(report.ok, true);
  assert.equal(report.issues.some((entry) => entry.level === "warning" && entry.code.includes("kfd-2")), true);
});

test("release passport fails closed when a KFD-2 downgrade reason uses an unknown taxonomy value", () => {
  const { cwd, assetsDir, actualSha256 } = createKfdWitnessFixture();
  const claimPath = writeJson(path.join(cwd, "kfd-2-claim.json"), {
    id: "claim:kfd-private-downgrade-taxonomy",
    public: true,
    claim: "KFD release trust is downgraded by a taxonomy value not owned by KFD.",
    sourceBindings: [{ path: "docs/KFD-2.md", sha256: actualSha256 }],
    machineEvidence: [{ path: "release-notes.md", sha256: actualSha256 }],
    hashes: { sourceSha256: actualSha256, evidenceSha256: actualSha256 },
    artifacts: [{ name: "generic.schema", path: "config.schema.json", sha256: actualSha256 }],
    verification: { result: "passed" },
    auditBoundary: { scope: "release notes" },
    responsibility: { owner: "KFD maintainers" },
    residualRisk: [],
    downgradeReason: {
      id: "private-taxonomy-value",
      riskType: "local-private-risk",
      trustImpact: "downgrade-warning",
      reason: "This intentionally uses a taxonomy value outside KFD.",
    },
  });

  assert.throws(() => collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd2ClaimJsons: [claimPath],
  }), /local-private-risk|unknown taxonomy values fail validation|github.com\/kungfu-systems\/kfd\/issues\/new/);
});

test("release passport fails closed when a KFD-3-derived KFD-2 claim lacks a trust proof", async () => {
  const { cwd, assetsDir, actualSha256 } = createKfdWitnessFixture();
  const claimPath = writeJson(path.join(cwd, "kfd-2-claim.json"), {
    id: "kfd-3:manual-claim",
    public: true,
    claim: "KFD-3 collaboration interface is machine-bound but not projected as a KFD-2 trust proof.",
    sourceBindings: [{ path: "docs/KFD-3.md", sha256: actualSha256 }],
    machineEvidence: [{ path: "kfd-3-witness.json", sha256: actualSha256 }],
    hashes: { prebuildWitnessSha256: actualSha256, artifactWitnessSha256: actualSha256 },
    artifacts: [{ name: "generic.schema", path: "config.schema.json", sha256: actualSha256 }],
    verification: { result: "passed" },
    auditBoundary: { scope: "collaboration-interface" },
    responsibility: { owner: "KFD maintainers" },
    residualRisk: [],
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v1.0.0-alpha.3",
    repository: "kungfu-systems/kfd",
    productName: "KFD",
    sourceSha: "d".repeat(40),
    assetsDir: path.relative(cwd, assetsDir),
    outputDir: "release-passport",
    releaseJsonExtra: JSON.stringify({
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
    }),
    kfd2ClaimJsons: [claimPath],
  });
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(passport["kfd-2"].claims[0].missingBindings.length, 0);
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /KFD-2 trust proof|kfd-2\.claims\[0\]\.trustProof/);
});

test("release passport records KFD-3 residual risk without claiming full closure", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture({
    nonExhaustiveSurfaces: [{ id: "user-scripts", kind: "extension-point", reason: "User-provided scripts are not enumerable." }],
  });
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
  assert.equal(passport[metadata.key].releaseStatus, "audited");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].releaseStatus, "audited");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].residualRisk[0].id, "user-scripts");
  assert.equal(
    passport[metadata.key].collaborationInterfaces[0].reverseAudit.nonExhaustivelyEnumerableSurfaces[0].id,
    "user-scripts",
  );
  assert.notEqual(passport[metadata.key].collaborationInterfaces[0].releaseStatus, "enforced");
});

test("release passport fails closed when KFD-3 prebuild residual risk lacks taxonomy fields", () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath } = createKfd3WitnessFixture();
  const prebuild = JSON.parse(fs.readFileSync(prebuildWitnessPath, "utf8"));
  prebuild.extensionRequests = [
    {
      id: "taxonomy-extension",
      participants: ["agent", "maintainer"],
      trigger: "KFD-2 trust taxonomy lacks the value needed by this KFD-3 witness.",
      requestPath: {
        kind: "github-issue",
        target: "https://github.com/kungfu-systems/kfd",
        template: "https://github.com/kungfu-systems/kfd/issues/new?title=KFD-2%20trust%20taxonomy%20extension%20request",
      },
    },
  ];
  prebuild.residualRisk = [
    {
      id: "missing-taxonomy",
      reason: "This risk intentionally omits KFD-2 taxonomy fields.",
      owner: "KFD maintainers",
    },
  ];
  writeJson(prebuildWitnessPath, prebuild);

  assert.throws(() => collectGitHubReleasePassport({
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
  }), /missing-taxonomy|riskType|github.com\/kungfu-systems\/kfd\/issues\/new/);
});

test("release passport fails closed when KFD-3 artifact residual risk uses an unknown taxonomy value", () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath } = createKfd3WitnessFixture();
  const artifact = JSON.parse(fs.readFileSync(artifactWitnessPath, "utf8"));
  artifact.residualRisk = [
    {
      id: "unknown-artifact-risk",
      definedBy: "https://kfd.libkungfu.dev/schemas/kfd-2/trust-taxonomy.schema.json#/$defs/residualRisk",
      riskType: "local-private-risk",
      trustImpact: "downgrade-warning",
      machineProvability: "not-machine-verifiable",
      agentAction: "open-kfd-extension-issue",
      reason: "This intentionally uses a value not owned by KFD.",
      owner: "KFD maintainers",
    },
  ];
  writeJson(artifactWitnessPath, artifact);

  assert.throws(() => collectGitHubReleasePassport({
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
  }), /local-private-risk|unknown taxonomy values fail validation|github.com\/kungfu-systems\/kfd\/issues\/new/);
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
  assert.equal(passport[metadata.key].collaborationInterfaces[0].declaredCapabilityVerification.result, "failed");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].trustProof.result, "fail");
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
  assert.equal(passport[metadata.key].collaborationInterfaces[0].reverseAudit.status, "failed");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].trustProof.result, "fail");
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

test("release passport records KFD-3 draft downgrade as trust proof failure", async () => {
  const { cwd, assetsDir, prebuildWitnessPath, artifactWitnessPath, metadata } = createKfd3WitnessFixture({
    supportLevel: "draft",
  });
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: "v4.0.0-alpha.0",
    repository: "kungfu-systems/kungfu",
    productName: "Kungfu",
    sourceSha: "c".repeat(40),
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
  assert.equal(passport[metadata.key].releaseStatus, "draft");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].comparison.status, "downgraded");
  assert.equal(passport[metadata.key].collaborationInterfaces[0].trustProof.result, "downgraded");
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /support-level-draft|downgraded/);
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

test("release passport rejects version-bound impact from another minor line", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      release: { version: "2.3.2", line: "v2.2" },
      versionImpact: {
        final: "patch",
        source: "buildchain-version-state",
        rationale: "The impact is intentionally bound to the wrong minor line.",
      },
      surfaceImpacts: [
        {
          id: "release-impact-version-binding",
          impact: "patch",
          class: "release-evidence",
          rationale: "The fixture proves stale minor-line evidence fails closed.",
        },
      ],
      classification: "patch",
      summary: "Version-bound impact fixture for cross-minor rejection.",
    },
  });
  const report = await verifyReleasePassport({ passportLocation: passportPath });

  assert.equal(report.ok, false);
  assert.equal(report.issues.some((entry) => entry.code === "impact.release.line"), true);
  assert.match(JSON.stringify(report.issues), /impact release line must match/);
});

test("release passport rejects incomplete or mismatched version-bound impact", async () => {
  const passportPath = createUnifiedPassportFixture({
    impact: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      release: { version: "2.3.1", line: "v2.3" },
      versionImpact: {
        final: "patch",
        source: "buildchain-version-state",
        rationale: "The fixture intentionally omits valid release impact facts.",
      },
      surfaceImpacts: [],
      classification: "minor",
      summary: "",
    },
  });
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  const issueCodes = new Set(report.issues.map((entry) => entry.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("impact.release.version"), true);
  assert.equal(issueCodes.has("impact.classification"), true);
  assert.equal(issueCodes.has("impact.summary"), true);
  assert.equal(issueCodes.has("impact.surfaceImpacts.required"), true);
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
