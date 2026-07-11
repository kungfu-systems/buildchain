import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILDCHAIN_CONTRACT_LOCK,
  BUILDCHAIN_RUNTIME_CONTRACT_WORLD,
  createBuildchainContractLock,
  createBuildchainContractWorld,
  evaluateBuildchainContractLock,
  finalizeBuildchainContractWorld,
  readBuildchainContractWorld,
  renderBuildchainContractDriftIssueBody,
} from "../packages/core/buildchain-contract.js";
import {
  checkBuildchainContractLock,
  writeBuildchainContractLock,
} from "../scripts/buildchain-contract-lock.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-contract-${name}-`));
}

test("Buildchain contract lock allows compatible floating SHA drift", () => {
  const current = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const lock = createBuildchainContractLock({
    buildchainRef: "v2",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
    acceptedAt: "2026-07-06T00:00:00.000Z",
  });
  const additive = finalizeBuildchainContractWorld({
    ...current,
    surfaces: current.surfaces.map((surface) => (
      surface.id === "reusable-build"
        ? { ...surface, optionalInputs: surface.optionalInputs.concat("new-optional-input") }
        : surface
    )),
  });

  assert.equal(lock.contract, BUILDCHAIN_CONTRACT_LOCK);
  assert.equal(additive.contract, BUILDCHAIN_RUNTIME_CONTRACT_WORLD);
  assert.notEqual(additive.contractDigest, lock.buildchain.contractDigest);
  assert.equal(additive.compatibilityDigest, lock.buildchain.compatibilityDigest);

  const result = evaluateBuildchainContractLock({
    lock,
    current: additive,
    runtimeRef: "v2",
    runtimeSha: "b".repeat(40),
    runtimeClass: "stable",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "compatible-drift");
  assert.equal(result.drift, true);
  assert.equal(result.issueRecommended, true);
});

test("Buildchain contract lock fails closed on breaking drift", () => {
  const current = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const lock = createBuildchainContractLock({
    buildchainRef: "v2",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
  });
  const breaking = finalizeBuildchainContractWorld({
    ...current,
    surfaces: current.surfaces.map((surface) => (
      surface.id === "release-candidate-promote"
        ? { ...surface, breakingDigest: "sha256:" + "0".repeat(64) }
        : surface
    )),
  });

  const result = evaluateBuildchainContractLock({
    lock,
    current: breaking,
    runtimeRef: "v2",
    runtimeSha: "b".repeat(40),
    runtimeClass: "stable",
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "breaking-drift");
  assert.match(result.reasons.join("\n"), /release-candidate-promote/);
});

test("Buildchain contract lock script writes drift issue body for compatible drift", () => {
  const workspace = tempDir("script");
  const runtime = path.join(workspace, "runtime");
  fs.mkdirSync(path.join(runtime, "dist", "site"), { recursive: true });
  const current = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const lock = createBuildchainContractLock({
    buildchainRef: "v2",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
  });
  const additive = finalizeBuildchainContractWorld({
    ...current,
    surfaces: current.surfaces.map((surface) => (
      surface.id === "kfd-1-release-gate"
        ? { ...surface, optionalInputs: (surface.optionalInputs || []).concat("future-witness-field") }
        : surface
    )),
  });
  const lockPath = path.join(workspace, ".buildchain", "contract-lock.json");
  const contractPath = path.join(runtime, "dist", "site", "buildchain-contract.json");
  const issueBodyPath = path.join(workspace, "issue.md");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  fs.writeFileSync(contractPath, `${JSON.stringify(additive, null, 2)}\n`);

  const result = checkBuildchainContractLock({
    lockPath,
    currentContractPath: contractPath,
    runtimeRoot: runtime,
    runtimeRef: "v2",
    runtimeSha: "b".repeat(40),
    runtimeClass: "stable",
    issueBodyPath,
    repository: "kungfu-systems/buildchain",
    workflow: "Build Surface Fixture",
    runUrl: "https://github.com/kungfu-systems/buildchain/actions/runs/1",
  });

  assert.equal(result.evaluation.status, "compatible-drift");
  assert.equal(result.shouldIssue, true);
  assert.match(fs.readFileSync(issueBodyPath, "utf8"), /Buildchain contract drift/);
});

test("contract world exposes KFD-3 collaboration-interface release gate", () => {
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const surface = contract.surfaces.find((entry) => (
    entry.id === "kfd-3-collaboration-interface-release-gate"
  ));

  assert.ok(surface);
  assert.match(surface.requiredInputs.join("\n"), /KFD-3 prebuild witness JSON/);
  assert.match(surface.requiredInputs.join("\n"), /KFD-3 artifact witness JSON or verify command/);
  assert.equal(
    surface.breakingDefaults.releaseGateContract,
    "kungfu-buildchain-kfd-3-collaboration-interface-release-gate",
  );
  assert.match(surface.guarantees.join("\n"), /releaseStatus, witness hashes/);
});

test("contract world exposes KFD-2 release trust passport audit", () => {
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const surface = contract.surfaces.find((entry) => (
    entry.id === "kfd-2-release-trust-passport-audit"
  ));

  assert.ok(surface);
  assert.match(surface.requiredInputs.join("\n"), /public release claim evidence/);
  assert.equal(
    surface.breakingDefaults.releaseTrustPassportContract,
    "kungfu-buildchain-kfd-2-release-trust-passport-audit",
  );
  assert.match(surface.guarantees.join("\n"), /Unbound public claims fail/i);
});

test("contract world exposes web-surface floating contract lock gate", () => {
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const surface = contract.surfaces.find((entry) => entry.id === "web-surface");

  assert.ok(surface);
  assert.equal(surface.path, ".github/workflows/.web-surface.yml");
  assert.match(surface.publicRef, /\.github\/workflows\/\.web-surface\.yml@v2/);
  assert.match(surface.optionalInputs.join("\n"), /buildchain-contract-lock-path/);
  assert.match(surface.optionalInputs.join("\n"), /buildchain-contract-compatibility-policy/);
  assert.match(surface.optionalInputs.join("\n"), /buildchain-contract-drift-issue-mode/);
  assert.equal(surface.breakingDefaults.breakingDriftPolicy, "fail-closed-before-build");
  assert.match(surface.guarantees.join("\n"), /before caller build/);
  assert.match(surface.guarantees.join("\n"), /breaking contract drift fails closed/);
});

test("write-lock records resolved SHA and contract digest", () => {
  const workspace = tempDir("write-lock");
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const contractPath = path.join(workspace, "buildchain-contract.json");
  const lockPath = path.join(workspace, ".buildchain", "contract-lock.json");
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const lock = writeBuildchainContractLock({
    output: lockPath,
    currentContractPath: contractPath,
    buildchainRef: "v2",
    resolvedSha: "c".repeat(40),
    acceptedAt: "2026-07-06T00:00:00.000Z",
  });

  assert.equal(lock.buildchain.resolvedSha, "c".repeat(40));
  assert.equal(lock.buildchain.contractDigest, contract.contractDigest);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).contract, BUILDCHAIN_CONTRACT_LOCK);
});

test("released contract worlds preserve their authoritative digests", () => {
  const workspace = tempDir("released-world-round-trip");
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.12.0-alpha.1" },
  });
  const contractPath = path.join(workspace, "buildchain-contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const released = readBuildchainContractWorld(contractPath);

  assert.equal(released.contractDigest, contract.contractDigest);
  assert.equal(released.compatibilityDigest, contract.compatibilityDigest);
});

test("released contract worlds reject digest replacement instead of silently recomputing", () => {
  const workspace = tempDir("released-world-digest-mismatch");
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.12.0-alpha.1" },
  });
  const contractPath = path.join(workspace, "buildchain-contract.json");
  fs.writeFileSync(contractPath, `${JSON.stringify({
    ...contract,
    contractDigest: "sha256:published-authoritative-digest",
  }, null, 2)}\n`);

  assert.throws(
    () => readBuildchainContractWorld(contractPath),
    /published contractDigest mismatch/,
  );
});

test("contract drift issue body explains compatible and breaking next actions", () => {
  const body = renderBuildchainContractDriftIssueBody({
    repository: "kungfu-systems/libnode",
    workflow: "Build",
    lockPath: ".buildchain/contract-lock.json",
    evaluation: {
      status: "compatible-drift",
      compatible: true,
      policy: "major-compatible",
      accepted: { ref: "v2", resolvedSha: "a".repeat(40), contractDigest: "sha256:old" },
      current: { ref: "v2", resolvedSha: "b".repeat(40), contractDigest: "sha256:new" },
      reasons: [],
    },
  });

  assert.match(body, /Buildchain contract drift/);
  assert.match(body, /\.buildchain\/contract-lock\.json/);
  assert.match(body, /Review the Buildchain release notes/);
});
