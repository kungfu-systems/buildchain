import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sealPackageCandidate } from "../packages/core/build/nodes/package-candidate.mjs";
import { sha256Json } from "../packages/core/release/release-candidate.js";
const tree = "a".repeat(40);
const passport = {
  source: { headSha: "b".repeat(40), treeHash: tree },
  candidateHash: "c".repeat(64),
  diagnostics: { buildSummaryHash: "d".repeat(64) },
  buildchain: { sha: "e".repeat(40) },
};
function directory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "package-node-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("package manifest binds exactly one archive to candidate, build summary, source and runtime", (t) => {
  const outputDir = directory(t);
  fs.writeFileSync(path.join(outputDir, "buildchain.tgz"), "product bytes");
  const manifest = sealPackageCandidate({ passport, tree, outputDir });
  const { root, ...body } = manifest;
  assert.equal(root, `sha256:${sha256Json(body)}`);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].size, 13);
  assert.equal(manifest.source.tree, tree);
  assert.equal(manifest.source.sha, passport.source.headSha);
  assert.equal(manifest.candidateRoot, `sha256:${passport.candidateHash}`);
  assert.equal(
    manifest.buildSummaryRoot,
    `sha256:${passport.diagnostics.buildSummaryHash}`,
  );
  assert.equal(manifest.runtimeSha, passport.buildchain.sha);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(outputDir, "product-payload-manifest.json")),
    ),
    manifest,
  );
  fs.appendFileSync(path.join(outputDir, "buildchain.tgz"), "changed");
  assert.notEqual(
    sealPackageCandidate({ passport, tree, outputDir }).root,
    manifest.root,
  );
});
test("package sealing refuses source drift, absent payload and ambiguous tarballs", (t) => {
  const outputDir = directory(t);
  assert.throws(
    () => sealPackageCandidate({ passport, tree: "f".repeat(40), outputDir }),
    /differs/,
  );
  assert.throws(
    () => sealPackageCandidate({ passport, tree, outputDir }),
    /found 0/,
  );
  fs.writeFileSync(path.join(outputDir, "one.tgz"), "one");
  fs.writeFileSync(path.join(outputDir, "two.tgz"), "two");
  assert.throws(
    () => sealPackageCandidate({ passport, tree, outputDir }),
    /found 2/,
  );
  assert.equal(
    fs.existsSync(path.join(outputDir, "product-payload-manifest.json")),
    false,
  );
});
