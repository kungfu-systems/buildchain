import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { verifyPipelineProductFiles } from "../packages/core/publication/pipeline/files.js";
import { verifyPipelineNativeInputs } from "../packages/core/publication/pipeline/native-inputs.js";
import { publicationFile } from "../packages/core/publication/pipeline/files.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { createArtifactSigningRequest } from "../packages/core/build/artifact-signing.js";
import { artifactSigningRequestRoot } from "../packages/core/build/signing/request.js";
import { inspectArtifactSigningRequests } from "../packages/core/build/signing/intake.js";
import { loadArtifactSigningInput } from "../packages/core/build/macos-credential-island/input.js";

const write = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
import { nativeInputFixture } from "./helpers/pipeline-native-input-fixture.mjs";

const verify = (f) =>
  verifyPipelineNativeInputs({
    directory: f.output,
    manifest: f.manifest,
    plan: f.plan,
    source: f.source,
  });

function rerootTransport(f) {
  // Simulate an attacker rewriting every self-authored transport checksum.
  // The admitted source, plan and original unsigned artifact remain fixed.
  f.manifest.nativeSigning.indexRoot = artifactSigningRequestRoot(f.index);
  for (const item of f.manifest.nativeSigning.files) {
    const observed = publicationFile(path.join(f.output, item.file));
    item.size = observed.size;
    item.digest = observed.digest;
  }
  const { root, ...body } = f.manifest;
  f.manifest.root = recordDigest(body);
}

test("unsigned native archives produce exact sealed authority requests without credentials", (t) => {
  const f = nativeInputFixture(t);
  const admitted = verify(f);
  assert.equal(admitted.indexRoot, f.manifest.nativeSigning.indexRoot);
  assert.equal(f.request.artifact.digest, f.manifest.artifacts[0].digest);
  assert.equal(f.request.runtime.sha, f.plan.runtime.commit);
  const matrix = inspectArtifactSigningRequests({
    inputRoot: admitted.directory,
    expectedRepository: f.source.repository,
    expectedRequestRoot: admitted.indexRoot,
  });
  assert.equal(matrix.macos.length, 1);
  verifyPipelineProductFiles(f.output, f.manifest);
  const { root, ...downgrade } = f.manifest;
  downgrade.schema = "buildchain.pipeline-publication-products/v1";
  assert.throws(
    () =>
      verifyPipelineProductFiles(f.output, {
        ...downgrade,
        root: recordDigest(downgrade),
      }),
    /manifest root/,
  );
  fs.appendFileSync(
    path.join(f.requestRoot, f.request.artifact.transport.file),
    "changed",
  );
  assert.throws(() => verify(f), /changed after its manifest/);
  assert.throws(
    () => verifyPipelineProductFiles(f.output, f.manifest),
    /changed after its manifest/,
  );
});

test("native inputs reject substituted source and optional signatures even after all local roots are rebuilt", (t) => {
  for (const mutate of [
    (request) => {
      request.source.sha = "e".repeat(40);
    },
    (request) => {
      request.runtime.sha = "e".repeat(40);
    },
    (request) => {
      request.signature.required = false;
    },
  ]) {
    const f = nativeInputFixture(t);
    mutate(f.request);
    f.request = createArtifactSigningRequest(f.request);
    f.index.requests[0].digest = f.request.digest;
    write(f.requestPath, f.request);
    write(f.indexPath, f.index);
    rerootTransport(f);
    assert.throws(() => verify(f), /source and signature declaration/);
  }
});

test("native transport cannot substitute bytes for the separately sealed unsigned product", (t) => {
  const f = nativeInputFixture(t);
  const file = path.join(f.requestRoot, f.request.artifact.transport.file);
  fs.appendFileSync(file, "replacement");
  const bytes = publicationFile(file);
  f.request.artifact.transport.bytes = bytes.size;
  f.request.artifact.transport.digest = bytes.digest;
  f.request = createArtifactSigningRequest(f.request);
  f.index.requests[0].digest = f.request.digest;
  write(f.requestPath, f.request);
  write(f.indexPath, f.index);
  rerootTransport(f);
  assert.throws(() => verify(f), /differs from the sealed unsigned archive/);
  f.manifest.nativeSigning.files.push(f.manifest.nativeSigning.files[0]);
  rerootTransport(f);
  assert.throws(() => verify(f), /incomplete or duplicated/);
});

test(
  "macOS app transport carries a source-bound expected bundle identity into the credential island",
  { skip: process.platform !== "darwin" },
  (t) => {
    const f = nativeInputFixture(t, true);
    const admitted = verify(f);
    const loaded = loadArtifactSigningInput(admitted.directory, {
      repository: f.source.repository,
      sourceSha: f.source.commit,
      sourceTreeSha: f.source.tree,
      platformId: "macos-arm64",
      artifactId: f.plan.nativeSigning[0].id,
    });
    assert.equal(loaded.manifest.app.bundleId, "io.kungfu.app");
    assert.equal(loaded.request.artifact.transport.format, "ditto-zip");
    assert.equal(loaded.request.digest, f.request.digest);
    assert.equal(loaded.manifest.app.archivePath, "Kungfu.app");
    // GitHub pattern downloads retain a named artifact directory under intake.
    const intake = path.join(f.cwd, "authority-intake");
    const nested = path.join(intake, "provider-artifact-name");
    fs.cpSync(admitted.directory, nested, { recursive: true });
    const wrapped = loadArtifactSigningInput(intake, {
      repository: f.source.repository,
      sourceSha: f.source.commit,
      sourceTreeSha: f.source.tree,
      artifactId: f.plan.nativeSigning[0].id,
    });
    assert.equal(wrapped.request.digest, f.request.digest);
    assert.equal(wrapped.manifest.app.bundleId, "io.kungfu.app");
    assert.equal(
      wrapped.archivePath,
      path.join(nested, f.request.artifact.transport.file),
    );
  },
);
