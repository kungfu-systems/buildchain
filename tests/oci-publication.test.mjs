import {
  hash,
  fixture,
  provider,
  compoundFixture,
} from "./helpers/oci-publication-fixtures.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { verifyOciPublicationBundle } from "../packages/core/oci-publication-bundle.js";
import { resolveOciCandidate } from "../scripts/publication-candidate-kind.mjs";

import { createRecoveredPublication } from "../scripts/resume-from-candidate-run.mjs";
import {
  resolveCandidateProviderInputs,
  sealedCandidateVersion,
  planProductPublication,
} from "../actions/v4-release-candidate-promote/product-provider.js";
import {
  selectV4ProductPublicationIntent,
  createV4ProductPublicationPlan,
  createV4ProductPublicationDeclaration,
} from "../packages/core/v4-product-publication.js";
import { compileReleaseTailDeclaration } from "../packages/core/release-tail-provider-plane.js";

test("sealed OCI candidate verifies exact complete family and rejects tampering", (t) => {
  const f = fixture(t);
  const args = {
    bundleRoot: f.directory,
    manifest: f.manifest,
    repository: f.repository,
    sourceSha: f.sourceSha,
    version: f.version,
  };
  assert.equal(verifyOciPublicationBundle(args).root, f.manifest.root);
  const resolved = resolveOciCandidate({
    payloadRoot: f.directory,
    passport: {
      repository: f.repository,
      source: { headSha: f.sourceSha },
      target: { version: f.version },
    },
  });
  assert.equal(resolved.requiredArtifacts.length, 2);
  assert.throws(
    () => verifyOciPublicationBundle({ ...args, sourceSha: "b".repeat(40) }),
    /identity mismatch/u,
  );
  const altered = structuredClone(f.manifest);
  altered.images.pop();
  delete altered.root;
  altered.root = v4ContentRoot("oci-publication-family", altered);
  assert.throws(
    () => verifyOciPublicationBundle({ ...args, manifest: altered }),
    /incomplete/u,
  );
  fs.writeFileSync(path.join(f.directory, f.images[0].smoke.path), "tampered");
  assert.throws(
    () => verifyOciPublicationBundle(args),
    /smoke evidence digest/u,
  );
});

test("complete OCI publication is idempotent and retains anonymous digest evidence", async (t) => {
  for (const relativeLocation of [false, true]) {
    const f = fixture(t),
      p = provider(f, { uploadPath: "upload", relativeLocation });
    assert.equal((await p.adapter.readback(p.effect)).outcome, "absent");
    assert.equal((await p.adapter.apply(p.effect)).outcome, "observed");
    assert.equal(p.writes.length, 2);
    assert.equal((await p.adapter.apply(p.effect)).outcome, "observed");
    assert.equal(p.writes.length, 2);
    const evidence = JSON.parse(
      fs.readFileSync(
        path.join(f.directory, "evidence/oci-publication-readback.json"),
      ),
    );
    assert.ok(evidence.images.every((i) => i.anonymous));
    assert.ok(!JSON.stringify(evidence).includes("fixture-write-token"));
  }
});

test("partial mutation with lost response resumes only the missing image", async (t) => {
  const p = provider(fixture(t), { failOnce: true });
  await assert.rejects(
    p.adapter.apply(p.effect),
    /registry-transport-uncertain/u,
  );
  assert.equal(p.writes.length, 1);
  assert.equal((await p.adapter.apply(p.effect)).outcome, "observed");
  assert.equal(p.writes.length, 2);
});

test("upload continuations remain bound to the HTTPS registry and exact repository", async (t) => {
  for (const uploadLocation of [
    "https://ghcr.io/v2/example/foreign/base/blobs/upload/fixture",
    "https://ghcr.io/v2/example/images/base/manifests/fixture",
    "https://ghcr.io/v2/example/images/base/blobs/upload/",
    "https://attacker.invalid/v2/example/images/base/blobs/upload/fixture",
    "http://ghcr.io/v2/example/images/base/blobs/upload/fixture",
    "https://user:password@ghcr.io/v2/example/images/base/blobs/upload/fixture",
  ]) {
    const p = provider(fixture(t), { uploadLocation });
    await assert.rejects(
      p.adapter.apply(p.effect),
      /unsafe-registry-(upload-location|endpoint)/u,
    );
    assert.equal(p.writes.length, 0);
  }
});

test("a conflicting later family tag prevents every write", async (t) => {
  const f = fixture(t),
    p = provider(f, {
      tags: [[`example/images/child:v${f.version}`, Buffer.from("wrong")]],
    });
  await assert.rejects(
    p.adapter.apply(p.effect),
    /immutable-image-tag-conflict/u,
  );
  assert.equal(p.writes.length, 0);
});

test("registry upload endpoints cannot redirect credentials", async (t) => {
  const p = provider(fixture(t), {
    uploadLocation:
      "https://attacker.invalid/v2/example/images/base/blobs/uploads/fixture",
  });
  await assert.rejects(p.adapter.apply(p.effect), /unsafe-registry-endpoint/u);
  assert.equal(p.writes.length, 0);
});

test("OCI discovery and recovery preserve the sealed family into the rooted APPLY plan", async (t) => {
  const f = fixture(t);
  const passport = {
    repository: f.repository,
    source: { headSha: f.sourceSha, treeHash: "c".repeat(40) },
    target: { version: f.version },
    buildchain: { sha: "d".repeat(40) },
    candidateHash: "e".repeat(64),
  };
  const recovered = createRecoveredPublication({
    downloads: [],
    bundleRoot: f.directory,
    repository: f.repository,
    passport,
    candidateRuntimeSha: passport.buildchain.sha,
    publishArtifactKind: "oci",
    releasePatterns: "*-smoke.json",
    platformManifests: [],
    channel: "alpha",
  });
  assert.equal(recovered.manifest.root, f.manifest.root);
  assert.equal(recovered.bundleRoot, f.directory);
  assert.equal(recovered.publishRequiredArtifacts.length, 2);
  const paths = resolveCandidateProviderInputs({
    candidatePassportPath: path.join(f.directory, "passport.json"),
    artifactKind: "oci",
    sealedBundleRoot: recovered.bundleRoot,
    sealedBundleManifest: f.manifestPath,
    requiredArtifactsPath: f.requiredArtifactsPath,
  });
  assert.equal(paths.sealedBundleManifest, f.manifestPath);
  const intent = selectV4ProductPublicationIntent({
    channel: "alpha",
    targetRef: "alpha/v1/v1.3",
    sourceSha: f.sourceSha,
    sourceTimestamp: "2026-09-06T00:00:00Z",
    repository: f.repository,
    artifactKind: "oci",
    sealedBundleRoot: f.manifest.root,
    requiredArtifactsRoot: v4ContentRoot(
      "v4-product-required-artifacts",
      recovered.publishRequiredArtifacts,
    ),
    candidateVersion: f.version,
  });
  const request = { ...paths, candidate: passport, publicationIntent: intent };
  assert.equal(sealedCandidateVersion(request), f.version);
  assert.equal(
    (
      await planProductPublication(request, {
        fallbackVersion: f.version,
        fallbackTag: `v${f.version}`,
      })
    ).version,
    f.version,
  );
  const plan = createV4ProductPublicationPlan({
    intent,
    invocationRoot: `sha256:${"f".repeat(64)}`,
    transactionRoot: `sha256:${"1".repeat(64)}`,
  });
  assert.deepEqual(plan.operationOrder, [
    "product.version-state.materialize",
    "product.oci.publish",
    "product.release-refs.converge",
  ]);
  assert.equal(plan.operations[1].authority, "packages-write");
  const compiled = compileReleaseTailDeclaration(
    createV4ProductPublicationDeclaration({ intent, plan }),
  );
  assert.deepEqual(
    compiled.effects.map((e) => e.capabilityId),
    plan.operationOrder,
  );
});

test("compound OCI publication uploads both platforms before the index and preserves Compose bytes", async (t) => {
  const f = compoundFixture(t),
    verified = f.verify();
  assert.deepEqual(
    verified.graphs.get("base").platforms.map((v) => v.platform),
    ["linux/amd64", "linux/arm64"],
  );
  const p = provider(f);
  await p.adapter.apply(p.effect);
  assert.equal(p.writes.length, 4);
  assert.match(p.writes[0], /:sha256:/u);
  assert.match(p.writes[1], /:sha256:/u);
  assert.equal(p.writes[2], `example/images/base:v${f.version}`);
  assert.equal(p.writes[3], `example/images/base:compose-v${f.version}`);
  assert.equal(hash(p.tags.get(p.writes[3])), f.images[1].digest);
  await p.adapter.apply(p.effect);
  assert.equal(p.writes.length, 4);
  const recovered = resolveOciCandidate({
    payloadRoot: f.directory,
    passport: {
      repository: f.repository,
      source: { headSha: f.sourceSha },
      target: { version: f.version },
    },
  });
  assert.deepEqual(
    recovered.requiredArtifacts.map((v) => v.ref),
    [`v${f.version}`, `compose-v${f.version}`],
  );
});

test("compound OCI qualification rejects omitted architectures and altered nested bytes", (t) => {
  const f = compoundFixture(t);
  f.images[0].platforms.push("linux/s390x");
  f.reseal();
  assert.throws(f.verify, /incomplete image platform/u);
  f.images[0].platforms.pop();
  f.reseal();
  fs.writeFileSync(
    path.join(
      f.directory,
      f.images[0].layout,
      "blobs/sha256",
      f.armConfig.digest.slice(7),
    ),
    "{}",
  );
  assert.throws(f.verify, /blob size mismatch/u);
});

test("Compose cannot publish to a foreign repository, alias or floating image", (t) => {
  const f = compoundFixture(t),
    compose = f.images[1];
  compose.repository = "ghcr.io/example/foreign/base";
  f.reseal();
  assert.throws(f.verify, /destination must belong/u);
  compose.repository = f.images[0].repository;
  const document = JSON.parse(
    fs.readFileSync(
      path.join(
        f.directory,
        compose.layout,
        "blobs/sha256",
        compose.digest.slice(7),
      ),
    ),
  );
  document.layers = [
    f.blob(
      compose,
      { services: { app: { image: `${compose.repository}:latest` } } },
      f.layer.mediaType,
    ),
  ];
  const changed = f.blob(compose, document);
  compose.digest = changed.digest;
  fs.writeFileSync(
    path.join(f.directory, compose.layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [changed] }),
  );
  f.reseal();
  assert.throws(f.verify, /exact digests/u);
});

test("an existing conflicting Compose tag prevents image or child-manifest publication", async (t) => {
  const f = compoundFixture(t),
    p = provider(f, {
      tags: [
        [`example/images/base:compose-v${f.version}`, Buffer.from("conflict")],
      ],
    });
  await assert.rejects(
    p.adapter.apply(p.effect),
    /immutable-image-tag-conflict/u,
  );
  assert.deepEqual(p.writes, []);
});
