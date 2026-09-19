import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appSigningFixture } from "./helpers/macos-signing-fixture.mjs";
import { finalizeNativeArtifactSigningResult } from "../packages/core/build/signing/native-result.js";
import { artifactSigningRequestRoot } from "../packages/core/build/signing/request.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { verifyPipelineNativeResults } from "../packages/core/publication/pipeline/native-results.js";

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-native-result-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = appSigningFixture(root);
  const directory = path.join(root, "result");
  finalizeNativeArtifactSigningResult({
    requestRoot: f.input,
    requestPath: "app/request.json",
    signedPayload: f.zip,
    evidencePath: f.evidencePath,
    credentialArtifactRoot: f.credential,
    outputRoot: directory,
    expectedRunId: "1000",
    expectedRunAttempt: "2",
  });
  const index = JSON.parse(
    fs.readFileSync(path.join(f.input, "index.json"), "utf8"),
  );
  const rule = {
    id: "kungfu-app",
    product: "app",
    platform: "macos-arm64",
    artifact: "zip",
    installer: "dmg",
    kind: "app-bundle",
    profile: "apple-developer-id",
  };
  const plan = {
    runtime: {
      repository: "kungfu-systems/buildchain",
      commit: "3".repeat(40),
      tree: "d".repeat(40),
    },
    nativeSigning: [rule],
    outputs: ["zip", "dmg"].map((artifact) => ({
      id: `app/macos-arm64/${artifact}`,
      product: "app",
      platform: "macos-arm64",
      artifact,
    })),
  };
  const input = {
    directory: f.input,
    index,
    indexRoot: artifactSigningRequestRoot(index),
  };
  const operation = {
    requestRoot: input.indexRoot,
    runtimeSha: plan.runtime.commit,
    requestIds: [rule.id],
  };
  const body = {
    schema: "buildchain.pipeline-native-authority-readback/v1",
    operationRoot: recordDigest(operation),
    requestRoot: input.indexRoot,
    runtimeSha: plan.runtime.commit,
    runId: 1000,
    runAttempt: 2,
  };
  return {
    input,
    directory,
    operation,
    authority: { ...body, root: recordDigest(body) },
    plan,
    platform: "macos-arm64",
  };
}

test("native finalization binds both app containers to the admitted authority result", (t) => {
  const f = fixture(t);
  const verified = verifyPipelineNativeResults(f);
  assert.deepEqual(
    verified.replacements.map((item) => item.id),
    ["app/macos-arm64/zip", "app/macos-arm64/dmg"],
  );
  assert.equal(verified.receipts.length, 1);
  for (const item of verified.replacements)
    assert.ok(fs.existsSync(path.join(f.directory, item.file)));
});

test("native finalization rejects changed execution, missing results and altered DMG bytes", (t) => {
  const f = fixture(t);
  const authority = { ...f.authority, runAttempt: 3 };
  const { root, ...body } = authority;
  authority.root = recordDigest(body);
  assert.throws(
    () => verifyPipelineNativeResults({ ...f, authority }),
    /admitted authority execution/,
  );
  assert.throws(
    () =>
      verifyPipelineNativeResults({
        ...f,
        operation: { ...f.operation, runtimeSha: "4".repeat(40) },
      }),
    /admitted product requests/,
  );
  const indexPath = path.join(f.directory, "index.json");
  const original = fs.readFileSync(indexPath);
  fs.writeFileSync(indexPath, JSON.stringify({ results: [] }));
  assert.throws(
    () => verifyPipelineNativeResults(f),
    /every declared signing request/,
  );
  fs.writeFileSync(indexPath, original);
  const dmg = verifyPipelineNativeResults(f).replacements.find((item) =>
    item.id.endsWith("/dmg"),
  );
  fs.appendFileSync(path.join(f.directory, dmg.file), "tampered");
  assert.throws(
    () => verifyPipelineNativeResults(f),
    /evidence digest mismatch/,
  );
});

test("matching native payload bytes cannot authorize a symlink outside the result directory", (t) => {
  const f = fixture(t);
  const result = JSON.parse(
    fs.readFileSync(path.join(f.directory, "result.json"), "utf8"),
  );
  const payload = path.join(f.directory, result.artifact.path);
  const outside = path.join(path.dirname(f.directory), "outside.zip");
  fs.renameSync(payload, outside);
  fs.symlinkSync(outside, payload);
  assert.throws(() => verifyPipelineNativeResults(f), /symbolic links/);
});
