import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KFD2_PRODUCT_CLAIMS_REGISTRY_CONTRACT,
  checkKfd2ProductClaimOutputs,
  renderKfd2ProductClaimOutputs,
  validateKfd2ProductClaimsRegistry,
  writeKfd2ProductClaimOutputs,
} from "../packages/core/kfd2-product-claims.js";
import {
  BUILDCHAIN_KFD2_CLAIMS_DIR,
  BUILDCHAIN_KFD2_REGISTRY_PATH,
  BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH,
} from "../packages/core/buildchain-layout.js";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-kfd2-${name}-`));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const cwd = tempDir("product-claims");
  writeJson(path.join(cwd, "package.json"), {
    name: "@example/product",
    version: "1.2.3",
    type: "module",
  });
  fs.mkdirSync(path.join(cwd, ".buildchain"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".buildchain", "buildchain.toml"), [
    "schema = 1",
    "",
    "[version]",
    "required = true",
    "strategy = \"semver\"",
    "",
    "[[version.files]]",
    "type = \"json\"",
    "path = \"package.json\"",
    "key = \"version\"",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "dist"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "facts.json"), "{\"fact\":true}\n");
  fs.writeFileSync(path.join(cwd, "src", "evidence.json"), "{\"evidence\":true}\n");
  fs.writeFileSync(path.join(cwd, "dist", "artifact.json"), "{\"artifact\":true}\n");
  const registry = {
    schema: KFD2_PRODUCT_CLAIMS_REGISTRY_CONTRACT,
    product: {
      name: "Example Product",
      repository: "example/product",
      package: "@example/product",
    },
    releaseDefaults: {
      channel: "dev/v1/v1.2",
      tagPrefix: "v",
      sourceSha: "local-dev-snapshot",
    },
    kfd: {
      standard: "kfd-2",
      contract: "kfd-2-release-claims",
      interfaceVersion: 1,
    },
    buildchain: {
      checkCommand: "buildchain kfd 2 product-claims check",
    },
    claims: [{
      id: "fact-backed-product",
      category: "kfd-2",
      statement: "The product publishes one fact-backed artifact.",
      source: { kind: "file", path: "src/facts.json" },
      evidence: [{
        type: "file",
        path: "src/evidence.json",
        description: "Machine-readable evidence.",
      }],
      artifacts: [{
        name: "artifact",
        path: "dist/artifact.json",
        expectedPackagePath: "dist/artifact.json",
      }],
      verification: {
        command: "buildchain kfd 2 product-claims check",
        expectedResult: "pass",
      },
      auditBoundary: {
        scope: "The tracked fixture files.",
        enumerability: "closed-world",
        exclusions: [],
      },
      residualRisk: [],
      responsibility: {
        sourceOwner: "fixture",
        verificationOwner: "Buildchain",
        releaseDecisionOwner: "maintainer",
      },
      status: "audited",
    }],
  };
  writeJson(path.join(cwd, BUILDCHAIN_KFD2_REGISTRY_PATH), registry);
  return { cwd, registry };
}

test("KFD-2 product claims registry validates product intent and rejects malformed claims", () => {
  const { registry } = createFixture();
  const valid = validateKfd2ProductClaimsRegistry(registry);
  assert.equal(valid.ok, true);
  assert.equal(valid.claimCount, 1);

  const invalid = structuredClone(registry);
  invalid.claims[0].evidence = [];
  invalid.claims.push(structuredClone(invalid.claims[0]));
  const result = validateKfd2ProductClaimsRegistry(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "kfd-2.product-registry.evidence"));
  assert.ok(result.issues.some((entry) => entry.code === "kfd-2.product-registry.duplicate-claim"));
});

test("KFD-2 product claims render deterministically from configured version state", () => {
  const { cwd } = createFixture();
  const first = renderKfd2ProductClaimOutputs({ cwd });
  const second = renderKfd2ProductClaimOutputs({ cwd });
  assert.deepEqual(first.files, second.files);
  assert.equal(first.releaseClaims.release.version, "1.2.3");
  assert.equal(first.releaseClaims.release.channel, "dev/v1/v1.2");
  assert.equal(first.releaseClaims.release.tag, "v1.2.3");
  assert.equal(first.releaseClaims.release.sourceSha, "local-dev-snapshot");
  assert.equal(first.claims[0].public, true);
  assert.equal(first.claims[0].sourceBindings.length, 1);
  assert.equal(first.claims[0].machineEvidence.length, 1);
  assert.equal(first.claims[0].artifacts.length, 1);
  assert.match(first.claims[0].hashes.registrySha256, /^[a-f0-9]{64}$/);
});

test("KFD-2 product claims write/check detects drift and removes only stale generated claim JSON", () => {
  const { cwd } = createFixture();
  const options = { cwd, sourceSha: "local-dev-snapshot" };
  const before = checkKfd2ProductClaimOutputs(options);
  assert.equal(before.ok, false);
  assert.ok(before.issues.some((entry) => entry.code === "kfd-2.product-output.missing"));

  const stalePath = path.join(cwd, BUILDCHAIN_KFD2_CLAIMS_DIR, "stale.json");
  writeJson(stalePath, { stale: true });
  fs.writeFileSync(path.join(cwd, BUILDCHAIN_KFD2_CLAIMS_DIR, "notes.txt"), "keep\n");
  const written = writeKfd2ProductClaimOutputs(options);
  assert.deepEqual(written.removed, [path.relative(cwd, stalePath).split(path.sep).join("/")]);
  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD2_CLAIMS_DIR, "notes.txt")), true);
  assert.equal(checkKfd2ProductClaimOutputs(options).ok, true);

  fs.appendFileSync(path.join(cwd, "src", "evidence.json"), " \n");
  const drift = checkKfd2ProductClaimOutputs(options);
  assert.equal(drift.ok, false);
  assert.ok(drift.issues.some((entry) => entry.code === "kfd-2.product-output.drift"));
});

test("KFD-2 product claims CLI writes and checks the canonical Buildchain layout", () => {
  const { cwd } = createFixture();
  const common = [
    "kfd", "2", "product-claims",
    "--cwd", cwd,
    "--source-sha", "local-dev-snapshot",
    "--json",
  ];
  const written = JSON.parse(execFileSync(process.execPath, [bin, ...common.slice(0, 3), "write", ...common.slice(3)], {
    cwd: root,
    encoding: "utf8",
  }));
  assert.equal(written.status, "written");
  assert.equal(fs.existsSync(path.join(cwd, BUILDCHAIN_KFD2_RELEASE_CLAIMS_PATH)), true);

  const checked = JSON.parse(execFileSync(process.execPath, [bin, ...common.slice(0, 3), "check", ...common.slice(3)], {
    cwd: root,
    encoding: "utf8",
  }));
  assert.equal(checked.ok, true);

  fs.appendFileSync(path.join(cwd, "src", "facts.json"), " \n");
  const failed = spawnSync(process.execPath, [bin, ...common.slice(0, 3), "check", ...common.slice(3)], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, "mismatched");
});

test("KFD-2 product claims reject evidence paths that escape the product repository", () => {
  const { cwd, registry } = createFixture();
  registry.claims[0].source.path = "../outside.json";
  writeJson(path.join(cwd, BUILDCHAIN_KFD2_REGISTRY_PATH), registry);
  assert.throws(
    () => renderKfd2ProductClaimOutputs({ cwd, sourceSha: "a".repeat(40) }),
    /escapes repository root/,
  );
});
