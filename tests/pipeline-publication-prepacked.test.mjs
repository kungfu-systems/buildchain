import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { packPipelineProducts } from "../packages/core/publication/pipeline/pack.js";
import { verifyPipelineProductFiles } from "../packages/core/publication/pipeline/files.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

function fixture(t, change = {}) {
  const cwd = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pipeline-prepacked-"),
  );
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "package"));
  fs.writeFileSync(
    path.join(cwd, "package/package.json"),
    JSON.stringify({
      name: "@example/qualified-native",
      version: "1.0.0",
      scripts: {
        prepack: "node -e \"require('fs').writeFileSync('executed','yes')\"",
      },
      ...change,
    }),
  );
  fs.writeFileSync(
    path.join(cwd, "package/native.bin"),
    "qualified native bytes\n",
  );
  execFileSync("tar", ["-czf", "sealed.tgz", "package"], { cwd });
  const body = {
    schema: "buildchain.pipeline-publication-plan/v1",
    version: "1.0.0",
    outputs: [
      {
        id: "native/linux-x64/package",
        product: "native",
        platform: "linux-x64",
        artifact: "package",
        directory: ".",
        path: "sealed.tgz",
        kind: "npm-package",
        targets: [{ provider: "npm", access: "public" }],
      },
    ],
  };
  const input = {
    cwd,
    output: path.join(cwd, "packed"),
    plan: { ...body, root: recordDigest(body) },
    platform: "linux-x64",
    source: {
      repository: "example/product",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
  };
  return { cwd, input };
}

test("qualified prepacked npm inputs preserve exact bytes without executing package scripts", (t) => {
  const { cwd, input } = fixture(t);
  const bytes = fs.readFileSync(path.join(cwd, "sealed.tgz"));
  const manifest = packPipelineProducts(input);
  const artifact = manifest.artifacts[0];
  assert.deepEqual(
    fs.readFileSync(path.join(input.output, artifact.file)),
    bytes,
  );
  assert.deepEqual(artifact.package, {
    name: "@example/qualified-native",
    version: "1.0.0",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  });
  assert.equal(fs.existsSync(path.join(cwd, "package/executed")), false);
  assert.equal(fs.existsSync(path.join(input.output, "npm-pack")), false);
  verifyPipelineProductFiles(input.output, manifest);
});

test("prepacked npm inputs retain version, privacy and provider policy admission", (t) => {
  for (const change of [
    { name: null },
    { name: "../unrelated" },
    { version: "2.0.0" },
    { private: true },
    { publishConfig: { registry: "https://unrelated.invalid" } },
    { publishConfig: { scripts: "untrusted" } },
  ]) {
    const { input } = fixture(t, change);
    assert.throws(
      () => packPipelineProducts(input),
      /planned public package version|npm publication|publishConfig|npm package name/,
    );
  }
  const { cwd, input } = fixture(t);
  fs.writeFileSync(path.join(cwd, "sealed.tgz"), "not a tarball");
  assert.throws(() => packPipelineProducts(input));
});
