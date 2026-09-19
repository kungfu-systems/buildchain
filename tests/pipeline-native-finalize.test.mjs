import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { nativeInputFixture } from "./helpers/pipeline-native-input-fixture.mjs";
import { finalizeNativeArtifactSigningResult } from "../packages/core/build/signing/native-result.js";
import { finalizePipelineNativeProducts } from "../packages/core/publication/pipeline/native-finalize.js";
import { verifyPipelineProductFiles } from "../packages/core/publication/pipeline/files.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import {
  qualifyNativeFinalizedBundle,
  verifyRetainedNativeQualification,
} from "../packages/core/publication/pipeline/native-qualification.js";
import { qualifyPipelineProducts } from "../packages/core/publication/pipeline/qualification.js";
import { verifyPipelineQualification } from "../packages/core/publication/pipeline/documents.js";
import {
  retainPipelineProducts,
  restorePipelineProducts,
} from "../packages/core/publication/pipeline/sealed-products.js";

function fixture(t, script) {
  const f = nativeInputFixture(t, false, (product) => {
    product.finalize = [script];
  });
  const signed = path.join(f.cwd, "signed.tar.gz");
  fs.writeFileSync(path.join(f.cwd, "payload"), "signed fixture bytes");
  execFileSync("tar", ["-czf", "signed.tar.gz", "payload"], { cwd: f.cwd });
  const evidencePath = path.join(f.cwd, "evidence.json");
  fs.writeFileSync(
    evidencePath,
    JSON.stringify({
      contract: "kungfu-buildchain-apple-developer-id-evidence/v1",
      status: "passed",
      provider: "apple",
      artifactKind: "archive",
      notarization: {
        id: "fixture-not-a-real-notarization",
        status: "Accepted",
      },
      compound: { entitlementsProfile: "none", entitledPaths: [] },
      checks: [
        "codesign-strict",
        "developer-id-team",
        "hardened-runtime",
        "secure-timestamp",
        "compound-archive-safe-paths",
        "embedded-wheel-record-integrity",
        "notarytool-accepted",
        "compound-notary-ticket-online",
      ],
    }),
  );
  const signedDirectory = path.join(f.cwd, "signed-result");
  finalizeNativeArtifactSigningResult({
    requestRoot: f.requestRoot,
    requestPath: f.index.requests[0].path,
    signedPayload: signed,
    evidencePath,
    outputRoot: signedDirectory,
  });
  const operation = {
    requestRoot: f.manifest.nativeSigning.indexRoot,
    runtimeSha: f.plan.runtime.commit,
    requestIds: f.index.requests.map((item) => item.id),
  };
  const body = {
    schema: "buildchain.pipeline-native-authority-readback/v1",
    operationRoot: recordDigest(operation),
    requestRoot: operation.requestRoot,
    runtimeSha: operation.runtimeSha,
    runId: 100,
    runAttempt: 1,
  };
  const cwd = path.join(f.cwd, "finalizer");
  fs.mkdirSync(cwd);
  return {
    f,
    input: {
      cwd,
      output: path.join(f.cwd, "final-products"),
      plan: f.plan,
      source: f.source,
      bundle: { directory: f.output, manifest: f.manifest },
      signedDirectory,
      operation,
      authority: { ...body, root: recordDigest(body) },
      environment: {
        PATH: process.env.PATH,
        HOME: cwd,
        GITHUB_TOKEN: "must-not-reach-product",
      },
    },
  };
}

test("native finalizer runs the declared command without credentials and seals signed bytes without resealing unsigned requests", async (t) => {
  const { f, input } = fixture(
    t,
    `node -e "if(process.env.GITHUB_TOKEN)throw Error('credential');require('fs').readFileSync('.buildchain/native-unsigned/macos-arm64/index.json');require('fs').writeFileSync('finalized.marker','yes')"`,
  );
  let inspections = 0;
  const manifest = await finalizePipelineNativeProducts(input, {
    inspect: () => {
      inspections++;
      return f.contract;
    },
  });
  assert.equal(inspections, 2);
  assert.equal(
    fs.readFileSync(path.join(input.cwd, "finalized.marker"), "utf8"),
    "yes",
  );
  const unsignedRoot = path.join(
    input.cwd,
    ".buildchain/native-unsigned/macos-arm64",
  );
  const unsigned = JSON.parse(
    fs.readFileSync(path.join(unsignedRoot, "index.json")),
  );
  assert.equal(unsigned.manifestRoot, f.manifest.root);
  assert.deepEqual(unsigned.artifacts, f.manifest.artifacts);
  for (const artifact of unsigned.artifacts)
    assert.deepEqual(
      fs.readFileSync(path.join(unsignedRoot, artifact.file)),
      fs.readFileSync(path.join(f.output, artifact.file)),
    );
  assert.equal(manifest.nativeSigning.phase, "finalized");
  assert.equal(manifest.nativeSigning.unsignedManifestRoot, f.manifest.root);
  assert.equal(manifest.nativeSigning.requestRoot, undefined);
  assert.notEqual(manifest.artifacts[0].digest, f.manifest.artifacts[0].digest);
  verifyPipelineProductFiles(input.output, manifest);
  assert.ok(
    fs.existsSync(
      path.join(
        input.cwd,
        ".buildchain/native-signing/macos-arm64/receipt.json",
      ),
    ),
  );
});

test("product finalization cannot change a required signed archive", async (t) => {
  const { f, input } = fixture(
    t,
    `node -e "require('fs').appendFileSync('dist/hello.tar.gz','changed')"`,
  );
  await assert.rejects(
    finalizePipelineNativeProducts(input, { inspect: () => f.contract }),
    /changed required native signed bytes/,
  );
  assert.equal(fs.existsSync(path.join(input.output, "manifest.json")), false);
});

test("native qualification joins unsigned source, actual signer and separate finalizer without accepting a raw build as finalization", async (t) => {
  const { f, input } = fixture(t, 'node -e "process.exit(0)"');
  const manifest = await finalizePipelineNativeProducts(input, {
    inspect: () => f.contract,
  });
  const body = {
    schema: "buildchain.pipeline-native-finalization-readback/v1",
    outcome: "success",
    planRoot: f.plan.root,
    source: f.source,
    runId: 50,
    runAttempt: 1,
    providerSource: "a".repeat(40),
    platforms: ["macos-arm64"],
    artifactIds: [60],
    jobs: [
      {
        name: "Finalize publication (macos-arm64)",
        run_id: 50,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  const args = {
    plan: f.plan,
    producerPlan: f.plan,
    source: f.source,
    unsigned: input.bundle,
    signer: {
      directory: input.signedDirectory,
      operation: input.operation,
      proof: input.authority,
    },
    finalized: {
      build: { ...body, root: recordDigest(body) },
      bundles: [
        {
          directory: input.output,
          manifest,
          providerArtifact: {
            id: 60,
            expired: false,
            workflow_run: { id: 50, head_sha: body.providerSource },
          },
        },
      ],
    },
  };
  const admitted = qualifyNativeFinalizedBundle(args);
  assert.equal(admitted.proof.lineage.unsignedManifestRoot, f.manifest.root);
  const rawBuild = {
    schema: "buildchain.pipeline-publication-build-readback/v1",
    planRoot: f.plan.root,
    source: f.source,
    runId: 40,
    runAttempt: 1,
    outcome: "success",
    platforms: ["macos-arm64"],
    artifactIds: [41],
  };
  const qualified = qualifyPipelineProducts({
    plan: f.plan,
    source: f.source,
    bundles: [
      {
        ...input.bundle,
        providerArtifact: { id: 41, expired: false, workflow_run: { id: 40 } },
      },
    ],
    build: { ...rawBuild, root: recordDigest(rawBuild) },
    policyRoot: f.plan.contractRoot,
    native: {
      finalized: args.finalized,
      signers: [{ ...args.signer, platform: "macos-arm64" }],
    },
  });
  assert.equal(
    qualified.schema,
    "buildchain.pipeline-publication-qualification/v2",
  );
  verifyRetainedNativeQualification(qualified, f.plan);
  const material = {
    schema: "buildchain.pipeline-version-materialization/v1",
    planRoot: f.plan.root,
    protectedSource: f.source,
    source: f.source,
    material: { version: f.plan.version },
  };
  verifyPipelineQualification({
    plan: f.plan,
    qualified,
    materialization: { ...material, root: recordDigest(material) },
  });
  const retainedBytes = new Map();
  const archive = {
    put: async (bytes) => {
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      retainedBytes.set(digest, bytes);
      return { digest, size: bytes.length };
    },
    read: async (handle) => retainedBytes.get(handle.digest),
  };
  const sealed = await retainPipelineProducts(
    archive,
    qualified,
    args.finalized.bundles,
  );
  assert.equal(sealed.nativeFiles.length, 1);
  const restored = await restorePipelineProducts(
    archive,
    qualified,
    sealed,
    path.join(f.cwd, "restored-qualified"),
  );
  verifyPipelineProductFiles(restored, manifest);
  const missing = structuredClone(qualified);
  missing.native.platforms[0].lineage.verified.replacements = [];
  const { root: ignoredNative, ...nativeBody } = missing.native;
  missing.native.root = recordDigest(nativeBody);
  assert.throws(
    () => verifyRetainedNativeQualification(missing, f.plan),
    /omitted a required signed output/,
  );
  const raw = {
    ...body,
    schema: "buildchain.pipeline-publication-build-readback/v1",
  };
  assert.throws(
    () =>
      qualifyNativeFinalizedBundle({
        ...args,
        finalized: {
          ...args.finalized,
          build: { ...raw, root: recordDigest(raw) },
        },
      }),
    /independent finalization readback/,
  );
  const changed = structuredClone(manifest);
  changed.artifacts[0].id = "substituted-output";
  const { root, ...changedBody } = changed;
  changed.root = recordDigest(changedBody);
  assert.throws(
    () =>
      qualifyNativeFinalizedBundle({
        ...args,
        finalized: {
          ...args.finalized,
          bundles: [{ ...args.finalized.bundles[0], manifest: changed }],
        },
      }),
    /required signed bytes/,
  );
});
