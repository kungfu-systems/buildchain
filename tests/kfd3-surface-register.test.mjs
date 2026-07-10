import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkKfdUpstreamFacts,
  collectKfdAggregate,
  collectKfdStatus,
  collectKfdUpstreamFacts,
  discoverKfdStandards,
  kfd1,
  kfd2,
  kfd4,
  kfd3,
  listKfdUpstreamRoles,
  listKfdSchemas,
  readKfdSchema,
} from "@kungfu-tech/buildchain/kfd";
import {
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
  BUILDCHAIN_KFD2_CLAIMS_DIR,
  BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH,
  BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH,
  BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH,
  migrateBuildchainLayout,
} from "@kungfu-tech/buildchain";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-kfd3-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runBuildchain(args, options = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    encoding: "utf8",
  });
}

function createFixtureRepo() {
  const cwd = tempDir("repo");
  fs.mkdirSync(path.join(cwd, "bin"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist", "site"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(cwd, "docs", "api.md"), "# API\n");
  writeJson(path.join(cwd, "dist", "site", "site-manifest.json"), { contract: "fixture-site" });
  fs.writeFileSync(path.join(cwd, "bin", "fixture.mjs"), "#!/usr/bin/env node\n");
  writeJson(path.join(cwd, "package.json"), {
    name: "@example/fixture",
    version: "1.0.0",
    type: "module",
    main: "./src/index.js",
    types: "./src/index.d.ts",
    bin: { fixture: "./bin/fixture.mjs" },
    exports: {
      ".": "./src/index.js",
      "./sdk": "./src/sdk.js",
    },
  });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "index.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(cwd, "src", "sdk.js"), "export const sdk = true;\n");
  fs.writeFileSync(path.join(cwd, "src", "index.d.ts"), "export declare const ok: boolean;\n");
  const infoDir = path.join(cwd, "dist", "wheel", "fixture-1.0.0.dist-info");
  fs.mkdirSync(infoDir, { recursive: true });
  fs.writeFileSync(path.join(infoDir, "METADATA"), "Name: fixture\nVersion: 1.0.0\n");
  fs.writeFileSync(path.join(infoDir, "top_level.txt"), "fixture\n");
  fs.writeFileSync(path.join(infoDir, "RECORD"), "fixture/__init__.py,,\nfixture/api.py,,\nfixture-1.0.0.dist-info/METADATA,,\n");
  fs.writeFileSync(path.join(infoDir, "entry_points.txt"), "[console_scripts]\nfixture-py = fixture.cli:main\n");
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "dist", "fixture.exe"), "binary");
  return cwd;
}

test("KFD-3 detection recognizes npm exports, CLI bins, wheel metadata, docs, site facts, and binaries", () => {
  const cwd = createFixtureRepo();
  const detection = kfd3.detectSurfaces({ cwd, artifactPath: "dist/wheel" });

  assert.equal(detection.contract, "kungfu-buildchain-kfd-3-surface-detection");
  assert.ok(detection.surfaces.some((entry) => entry.id.includes("node-api:example/fixture/sdk")));
  assert.ok(detection.surfaces.some((entry) => entry.id === "cli:fixture"));
  assert.ok(detection.surfaces.some((entry) => entry.id === "python-api:fixture:fixture"));
  assert.ok(detection.surfaces.some((entry) => entry.id === "cli:fixture:fixture-py"));
  assert.ok(detection.surfaces.some((entry) => entry.id === "doc:docs/api.md"));
  assert.ok(detection.surfaces.some((entry) => entry.id === "site-bundle:dist/site/site-manifest.json"));
  assert.ok(detection.surfaces.some((entry) => entry.id === "binary:dist/fixture.exe"));
});

test("KFD-3 register, audit, witness, and query share one registry contract", async () => {
  const cwd = createFixtureRepo();
  kfd3.registerSurfaces({ cwd, kinds: ["node-api"], product: { id: "fixture", name: "Fixture" } });
  kfd3.registerSurfaces({ cwd, kinds: ["cli"], artifactPath: "dist/wheel" });
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH)), true);
  const audit = kfd3.auditSurfaces({ cwd, kinds: ["node-api", "cli"], artifactPath: "dist/wheel" });

  assert.equal(audit.status, "passed");
  assert.equal(audit.summary.declared > 0, true);

  const witness = kfd3.createSurfaceWitness({ cwd, kind: "prebuild", sourceSha: "a".repeat(40), artifactPath: "dist/wheel" });
  assert.equal(witness.standard, "kfd-3");
  assert.equal(witness.collaborationInterface.contract, "kungfu-buildchain-kfd-3-surface-registry");
  assert.match(witness.collaborationInterfaceDigest, /^sha256:/);

  const query = await kfd3.queryCapabilities({ cwd, product: "fixture", artifactPath: "dist/wheel" });
  assert.equal(query.contract, "kungfu-buildchain-kfd-3-capability-query");
  assert.equal(query.product, "fixture");
  assert.ok(query.capabilities.some((entry) => entry.kfd1Basis?.digest?.startsWith("sha256:")));
});

test("KFD-3 CLI is aligned with the Node API", () => {
  const cwd = createFixtureRepo();
  const register = JSON.parse(runBuildchain(["kfd", "3", "register", "node-api", "--cwd", cwd, "--product", "Fixture", "--json"]));
  assert.equal(register.contract, "kungfu-buildchain-kfd-3-surface-register");
  const audit = JSON.parse(runBuildchain(["kfd", "3", "audit", "--cwd", cwd, "--kind", "node-api", "--json"]));
  assert.equal(audit.status, "passed");
  const query = JSON.parse(runBuildchain(["kfd", "3", "query", "fixture", "--cwd", cwd, "--json"]));
  assert.equal(query.contract, "kungfu-buildchain-kfd-3-capability-query");
  assert.equal(query.capabilities.length, register.registrySurfaceCount);
});

test("Buildchain layout migration unifies KFD outputs under .buildchain/kfd", () => {
  const cwd = tempDir("layout-migration");
  const legacyRegistryPath = ".buildchain/kfd/kfd-3-surfaces.json";
  const legacyKfd1Path = ".buildchain/kfd/buildchain-kfd-1-witness.json";
  const legacyKfd2ClaimsDir = ".buildchain/kfd/kfd-2-claims";
  const legacyKfd3PrebuildPath = ".buildchain/kfd/buildchain-kfd-3-prebuild-witness.json";
  const legacyKfd3ArtifactPath = ".buildchain/kfd/buildchain-kfd-3-artifact-witness.json";
  writeJson(path.join(cwd, legacyRegistryPath), { contract: "legacy-registry" });
  writeJson(path.join(cwd, legacyKfd1Path), { contract: "legacy-kfd1" });
  writeJson(path.join(cwd, legacyKfd2ClaimsDir, "claim.json"), { id: "claim:legacy" });
  writeJson(path.join(cwd, legacyKfd3PrebuildPath), { contract: "legacy-prebuild" });
  writeJson(path.join(cwd, legacyKfd3ArtifactPath), { contract: "legacy-artifact" });

  const plan = migrateBuildchainLayout({ cwd });
  assert.equal(plan.status, "migration-needed");
  assert.ok(plan.moves.some((move) => move.from === legacyRegistryPath && move.to === BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH));
  assert.ok(plan.moves.some((move) => move.from === legacyKfd1Path && move.to === BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH));
  assert.ok(plan.moves.some((move) => move.from === legacyKfd2ClaimsDir && move.to === BUILDCHAIN_KFD2_CLAIMS_DIR));

  const applied = migrateBuildchainLayout({ cwd, write: true });
  assert.equal(applied.status, "applied");
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH)), true);
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH)), true);
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD2_CLAIMS_DIR, "claim.json")), true);
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH)), true);
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH)), true);
});

test("KFD CLI exposes all KFD standards through the unified schema namespace", () => {
  const schemas = listKfdSchemas();
  assert.ok(schemas.schemas.some((entry) => entry.standard === "kfd-1"));
  assert.ok(schemas.schemas.some((entry) => entry.standard === "kfd-2"));
  assert.ok(schemas.schemas.some((entry) => entry.standard === "kfd-3"));

  const cliList = JSON.parse(runBuildchain(["kfd", "schema", "list", "--json"]));
  assert.equal(cliList.contract, "kungfu-buildchain-kfd-schema-list");
  assert.ok(cliList.schemas.length >= schemas.schemas.length);

  const kfd1Schema = readKfdSchema({ standard: "kfd-1" });
  assert.equal(kfd1Schema.contract, "kungfu-buildchain-kfd-schema");
  const cliSchema = JSON.parse(runBuildchain(["kfd", "1", "schema", "--json"]));
  assert.equal(cliSchema.standard, "kfd-1");

  const kfd2Schemas = listKfdSchemas({ standard: "kfd-2" });
  assert.ok(kfd2Schemas.schemas.some((entry) => entry.name === "trustClaims"));
  assert.ok(kfd2Schemas.schemas.some((entry) => entry.name === "trustAssessment"));

  const kfd4Schemas = listKfdSchemas({ standard: "kfd-4" });
  assert.ok(kfd4Schemas.schemas.some((entry) => entry.name === "observerPerspective"));
});

test("Buildchain dogfoods KFD-1, KFD-2, and KFD-3 first-class APIs", async () => {
  const status = collectKfdStatus({ cwd: root });
  assert.deepEqual(status.support["kfd-1"], ["schema", "witness", "gate", "verify"]);
  assert.deepEqual(status.support["kfd-2"], ["schema", "taxonomy", "claims", "product-claims", "trust-claims", "trust-assessment", "upstream"]);
  assert.deepEqual(status.support["kfd-3"], ["schema", "detect", "register", "audit", "witness", "query", "aggregate"]);
  assert.deepEqual(status.support["kfd-4"], ["schema"]);
  assert.equal(status.paths.kfd2ProductClaimsRegistry.path, ".buildchain/kfd/kfd-2/registry.json");
  assert.equal(status.paths.kfd3SurfaceRegistry.path, BUILDCHAIN_KFD3_SURFACE_REGISTRY_PATH);

  const witness = kfd1.createBuildchainWitness({ root, sourceSha: "a".repeat(40) });
  assert.equal(witness.standard, "kfd-1");
  assert.match(witness.contractWorld.digest, /^sha256:/);

  const claims = kfd2.createBuildchainClaims({ root });
  assert.ok(claims.length > 0);
  assert.ok(claims.every((entry) => entry.public === true));
  assert.ok(claims.every((entry) => Array.isArray(entry.machineEvidence)));

  const foundationTrustClaims = kfd2.readFoundationTrustClaims();
  const trustClaimsValidation = kfd2.validateTrustClaims(foundationTrustClaims);
  assert.equal(foundationTrustClaims.contract, "kfd-2-trust-claims");
  assert.equal(trustClaimsValidation.ok, true);

  const foundationTrustAssessment = kfd2.readFoundationTrustAssessment();
  const trustAssessmentValidation = kfd2.validateTrustAssessment(foundationTrustAssessment);
  assert.equal(foundationTrustAssessment.contract, "kfd-2-trust-assessment");
  assert.equal(trustAssessmentValidation.ok, true);

  const cliTrustClaims = JSON.parse(runBuildchain(["kfd", "2", "trust-claims", "--json"]));
  assert.equal(cliTrustClaims.contract, "kungfu-buildchain-kfd-2-trust-claims");
  assert.equal(cliTrustClaims.validation.ok, true);

  const cliTrustAssessment = JSON.parse(runBuildchain(["kfd", "2", "trust-assessment", "--json"]));
  assert.equal(cliTrustAssessment.contract, "kungfu-buildchain-kfd-2-trust-assessment");
  assert.equal(cliTrustAssessment.validation.ok, true);

  const query = await kfd3.queryCapabilities({ cwd: root, product: "buildchain" });

  assert.equal(query.product, "Buildchain");
  assert.equal(query.source.type, "buildchain-site-kfd-claims");
  assert.ok(query.capabilities.some((entry) => entry.id === "export:./kfd" || entry.id === "export:./buildchain-kfd-claims"));

  assert.equal(kfd4.status, "schema-only");
  const kfd4Schema = readKfdSchema({ standard: "kfd-4" });
  assert.equal(kfd4Schema.standard, "kfd-4");
  assert.equal(readKfdSchema({ standard: "kfd-4", schema: "observerPerspective" }).name, "observerPerspective");
});

test("Buildchain dogfoods KFD upstream aggregate facts for the KFD package", () => {
  const upstream = collectKfdUpstreamFacts({ cwd: root });
  assert.equal(upstream.contract, "kungfu-buildchain-kfd-upstream-aggregate");
  assert.equal(upstream.summary.upstreamCount, 1);
  assert.deepEqual(upstream.summary.kfdAwareUpstreams, ["kfd"]);
  assert.equal(upstream.upstreams[0].package.name, "@kungfu-tech/kfd");
  assert.equal(upstream.upstreams[0].role, "standard-and-schema-provider");
  assert.equal(upstream.upstreams[0].roleSource, "known-package");
  assert.match(upstream.upstreams[0].roleReason, /Buildchain-known KFD upstream package/);
  assert.equal(upstream.upstreams[0].kfd.kfd1, "exported-witness");
  assert.equal(upstream.upstreams[0].kfd.kfd2, "exported-claim");
  assert.equal(upstream.upstreams[0].kfd.kfd3, "exported-collaboration-interface");
  assert.equal(upstream.upstreams[0].kfd.kfd4, "schema-metadata");
  assert.ok(upstream.upstreams[0].assets.some((entry) => entry.path === "standards.json" && entry.sha256.startsWith("sha256:")));
  assert.ok(upstream.upstreams[0].assets.some((entry) => (
    entry.path === ".buildchain/kfd/kfd-3/collaboration-interface.json" ||
    entry.path === ".buildchain/kfd-3/collaboration-interface.json"
  ) && entry.sha256.startsWith("sha256:")));

  const check = checkKfdUpstreamFacts(upstream);
  assert.equal(check.ok, true);

  const roles = listKfdUpstreamRoles();
  assert.equal(roles.contract, "kungfu-buildchain-kfd-upstream-role-registry");
  assert.ok(roles.roles.some((entry) => entry.role === "unknown-kfd-upstream"));
  assert.equal(roles.policy.unknownExplicitRole, "fail-closed");

  const invalidRole = collectKfdUpstreamFacts({
    cwd: root,
    components: [{ id: "kfd", package: "@kungfu-tech/kfd", role: "invented-role" }],
  });
  assert.equal(invalidRole.upstreams[0].role, "invented-role");
  assert.equal(invalidRole.upstreams[0].roleSource, "explicit");
  const invalidRoleCheck = checkKfdUpstreamFacts(invalidRole);
  assert.equal(invalidRoleCheck.ok, false);
  assert.ok(invalidRoleCheck.issues.some((entry) => entry.code === "kfd.upstream.upstreams[0].role"));

  const aggregate = collectKfdAggregate({ cwd: root });
  assert.equal(aggregate.contract, "kungfu-buildchain-kfd-aggregate");
  assert.equal(aggregate.upstreamCheck.status, "passed");

  const cliCollect = JSON.parse(runBuildchain(["kfd", "upstream", "collect", "--json"]));
  assert.equal(cliCollect.contract, upstream.contract);
  assert.equal(cliCollect.summary.packageVersions.kfd, upstream.summary.packageVersions.kfd);
  assert.equal(cliCollect.upstreams[0].roleSource, "known-package");

  const cliRoles = JSON.parse(runBuildchain(["kfd", "upstream", "roles", "--json"]));
  assert.equal(cliRoles.contract, roles.contract);
  assert.ok(cliRoles.roles.some((entry) => entry.role === "standard-and-schema-provider"));

  const cliCheck = JSON.parse(runBuildchain(["kfd", "upstream", "check", "--json"]));
  assert.equal(cliCheck.ok, true);

  const cliAggregate = JSON.parse(runBuildchain(["kfd", "aggregate", "--json"]));
  assert.equal(cliAggregate.contract, aggregate.contract);
  assert.equal(cliAggregate.upstreamCheck.status, "passed");
});

test("KFD upstream auto-discovery reads devDependencies without consumer role or semver duplication", () => {
  const cwd = tempDir("upstream-dev-dependency");
  writeJson(path.join(cwd, "package.json"), {
    name: "@example/kfd-consumer",
    version: "0.0.0",
    type: "module",
    devDependencies: {
      "@kungfu-tech/kfd": "1.0.0-alpha.21",
    },
  });
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".buildchain", "buildchain.toml"), [
    "schema = 1",
    "",
    "[kfd.upstream]",
    "auto_discover = true",
    "",
  ].join("\n"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "dir");

  const upstream = collectKfdUpstreamFacts({ cwd });
  assert.equal(upstream.source.autoDiscover, true);
  assert.equal(upstream.summary.upstreamCount, 1);
  assert.equal(upstream.upstreams[0].package.name, "@kungfu-tech/kfd");
  assert.equal(upstream.upstreams[0].package.version, discoverKfdStandards().package.version);
  assert.equal(upstream.upstreams[0].role, "standard-and-schema-provider");
  assert.equal(upstream.upstreams[0].roleSource, "known-package");
  assert.deepEqual(upstream.upstreams[0].kfd, {
    kfd1: "declared",
    kfd2: "declared",
    kfd3: "declared",
    kfd4: "declared",
  });

  const check = checkKfdUpstreamFacts(upstream);
  assert.equal(check.ok, true);
});
