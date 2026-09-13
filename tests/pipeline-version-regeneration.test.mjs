import assert from "node:assert/strict";
import test from "node:test";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { materializePipelineVersion } from "../packages/core/publication/pipeline/version.js";
import {
  pipelineVersionMaterialPaths,
  pipelineVersionRegenerationResult,
  collectPipelineVersionMaterial,
} from "../packages/core/publication/pipeline/version-regeneration.js";

function fixture() {
  const before = {
    "package.json":
      '{"version":"1.0.0-alpha.1","scripts":{"test":"node test.mjs"}}\n',
    "dist/facts.json": '{"version":"1.0.0-alpha.1"}\n',
  };
  const preparation = {
    root: `sha256:${"a".repeat(64)}`,
    source: {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      configPath: ".buildchain/buildchain.toml",
    },
    versionPolicy: {
      strategy: "semver",
      files: [{ path: "package.json", format: "json", key: "version" }],
      derived_files: ["dist/facts.json"],
    },
    version: "1.0.0-alpha.2",
    platforms: ["linux-x64", "windows-x64"],
  };
  const expected = materializePipelineVersion(
    preparation.versionPolicy,
    before,
    preparation.version,
  );
  const after = {
    ...before,
    ...Object.fromEntries(
      expected.changes.map(({ path, content }) => [path, content]),
    ),
    "dist/facts.json": '{"version":"1.0.0-alpha.2"}\n',
  };
  const result = (platform, files = after) =>
    pipelineVersionRegenerationResult(preparation, platform, files);
  return { preparation, before, after, result };
}

test("version regeneration combines declared derived bytes and preserves every other version document field", () => {
  const { preparation, before, after, result } = fixture();
  const results = [result("windows-x64"), result("linux-x64")];
  const material = collectPipelineVersionMaterial(preparation, before, results);
  assert.deepEqual(
    material.changes.map(({ path }) => path),
    ["dist/facts.json", "package.json"],
  );
  assert.deepEqual(JSON.parse(material.changes[1].content).scripts, {
    test: "node test.mjs",
  });
  assert.equal(material.changes[0].content, after["dist/facts.json"]);
  assert.deepEqual(
    collectPipelineVersionMaterial(preparation, before, results.toReversed()),
    material,
  );
  const unchangedDerived = {
    ...after,
    "dist/facts.json": before["dist/facts.json"],
  };
  assert.deepEqual(
    collectPipelineVersionMaterial(preparation, before, [
      result("linux-x64"),
      result("windows-x64", unchangedDerived),
    ]).changes,
    material.changes,
  );
});

test("regeneration rejects source substitution, missing platforms, undeclared files and executable version-field drift", () => {
  const { preparation, before, after, result } = fixture();
  const linux = result("linux-x64"),
    windows = result("windows-x64");
  assert.throws(
    () => collectPipelineVersionMaterial(preparation, before, [linux]),
    /every declared platform/,
  );
  assert.throws(
    () => collectPipelineVersionMaterial(preparation, before, [linux, linux]),
    /every declared platform/,
  );
  const { root, ...substituted } = linux;
  substituted.source = { ...substituted.source, commit: "c".repeat(40) };
  assert.throws(
    () =>
      collectPipelineVersionMaterial(preparation, before, [
        { ...substituted, root: recordDigest(substituted) },
        windows,
      ]),
    /preparation, source/,
  );
  assert.throws(
    () =>
      result("linux-x64", {
        ...after,
        ".github/workflows/backdoor.yml": "jobs: {}",
      }),
    /file inventory/,
  );
  const changedScript = after["package.json"].replace(
    "node test.mjs",
    "node publish.mjs",
  );
  assert.throws(
    () =>
      collectPipelineVersionMaterial(preparation, before, [
        result("linux-x64", { ...after, "package.json": changedScript }),
        windows,
      ]),
    /outside the planned version fields/,
  );
  assert.throws(
    () =>
      collectPipelineVersionMaterial(preparation, before, [
        result("linux-x64", before),
        windows,
      ]),
    /outside the planned version fields/,
  );
});

test("conflicting platform material and overlapping or authority-bearing declarations fail closed", () => {
  const { preparation, before, after, result } = fixture();
  assert.throws(
    () =>
      collectPipelineVersionMaterial(preparation, before, [
        result("linux-x64"),
        result("windows-x64", {
          ...after,
          "dist/facts.json": '{"version":"conflict"}',
        }),
      ]),
    /conflicting derived/,
  );
  for (const file of [
    "package.json",
    ".github/workflows/buildchain.yml",
    ".buildchain/buildchain.toml",
    ".buildchain/contract-lock.json",
    ".buildchain/alpha-contract-lock.json",
    "dist/*.json",
  ])
    assert.throws(
      () =>
        pipelineVersionMaterialPaths(
          { ...preparation.versionPolicy, derived_files: [file] },
          preparation.source.configPath,
        ),
      /disjoint path|cannot rewrite/,
    );
});
