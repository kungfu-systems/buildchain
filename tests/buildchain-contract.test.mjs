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
  const lockPath = path.join(workspace, "buildchain.contract-lock.json");
  const contractPath = path.join(runtime, "dist", "site", "buildchain-contract.json");
  const issueBodyPath = path.join(workspace, "issue.md");
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

test("write-lock records resolved SHA and contract digest", () => {
  const workspace = tempDir("write-lock");
  const contract = createBuildchainContractWorld({
    root: path.resolve(import.meta.dirname, ".."),
    packageJson: { name: "@kungfu-tech/buildchain", version: "2.8.0" },
  });
  const contractPath = path.join(workspace, "buildchain-contract.json");
  const lockPath = path.join(workspace, "buildchain.contract-lock.json");
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

test("contract drift issue body explains compatible and breaking next actions", () => {
  const body = renderBuildchainContractDriftIssueBody({
    repository: "kungfu-systems/libnode",
    workflow: "Build",
    lockPath: "buildchain.contract-lock.json",
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
  assert.match(body, /Review the Buildchain release notes/);
});
