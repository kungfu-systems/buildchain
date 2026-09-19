import test from "node:test";
import assert from "node:assert/strict";
import { summarizePackPreview } from "../packages/core/publication/npm/pack-preview.js";
import { parsePackResult } from "../packages/core/publication/npm/package.js";
import { assertPipelinePackagePolicy } from "../packages/core/publication/pipeline/package-policy.js";
import { parseNpmView } from "../packages/core/publication/npm/registry.js";

test("npm pack accepts one legacy array, direct result or npm 12 keyed package without guessing among packages", () => {
  const pack = {
    name: "@example/product",
    version: "1.0.0-alpha.1",
    filename: "example-product-1.0.0-alpha.1.tgz",
    integrity: "sha512-test",
    entryCount: 3,
    files: [{ path: "bin/buildchain.mjs", size: 10, mode: 493 }],
  };
  const expected = parsePackResult(JSON.stringify([pack]));
  assert.deepEqual(
    summarizePackPreview(JSON.stringify({ [pack.name]: pack })).files,
    pack.files,
  );
  assert.equal(summarizePackPreview(JSON.stringify([pack])).binMode, 493);
  assert.deepEqual(parsePackResult(JSON.stringify(pack)), expected);
  assert.equal(
    parsePackResult(JSON.stringify({ name: { ...pack, name: "name" } })).name,
    "name",
  );
  assert.deepEqual(
    parsePackResult(JSON.stringify({ [pack.name]: pack })),
    expected,
  );
  for (const value of [
    [],
    {},
    null,
    [pack, pack],
    { first: pack, second: pack },
  ])
    assert.throws(() => parsePackResult(JSON.stringify(value)), /exactly one/);
  for (const filename of ["../other.tgz", "dir/file.tgz", "dir\\file.tgz", ""])
    assert.throws(
      () => parsePackResult(JSON.stringify([{ ...pack, filename }])),
      /local tarball/,
    );
});

test("npm registry readback accepts npm 11 and 12 while ambiguous or missing integrity cannot look unpublished", () => {
  const item = {
    "dist.integrity": "sha512-observed",
    "dist.shasum": "observed",
  };
  assert.deepEqual(
    parseNpmView(JSON.stringify([item])),
    parseNpmView(JSON.stringify(item)),
  );
  assert.throws(
    () => parseNpmView(JSON.stringify([item, item])),
    /exactly one/,
  );
  assert.throws(() => parseNpmView("{}"), /omitted/);
  assert.throws(() => parseNpmView(""), /omitted/);
  assert.deepEqual(parseNpmView(JSON.stringify([item["dist.integrity"]])), {
    integrity: item["dist.integrity"],
    shasum: "",
  });
  assert.deepEqual(parseNpmView(JSON.stringify(item["dist.integrity"])), {
    integrity: item["dist.integrity"],
    shasum: "",
  });
});

test("sealed npm metadata cannot inject a scoped registry or execution configuration", () => {
  assertPipelinePackagePolicy({
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    },
  });
  for (const publishConfig of [
    { "@example:registry": "https://example.invalid" },
    { registry: "https://example.invalid" },
    { "node-options": "--import=untrusted" },
    { _authToken: "untrusted" },
  ])
    assert.throws(() => assertPipelinePackagePolicy({ publishConfig }), /npm/);
});
