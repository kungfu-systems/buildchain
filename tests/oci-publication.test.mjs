import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { verifyOciPublicationBundle } from "../packages/core/oci-publication-bundle.js";
import { createOciPublicationAdapter } from "../actions/v4-release-candidate-promote/oci-provider.js";
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

const hash = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-oci-test-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceSha = "a".repeat(40),
    repository = "example/images",
    version = "1.3.0-alpha.28";
  const images = ["base", "child"].map((name) => {
    const layout = `oci/${name}`;
    fs.mkdirSync(path.join(directory, layout, "blobs/sha256"), {
      recursive: true,
    });
    const blob = (object) => {
      const bytes = Buffer.from(JSON.stringify(object));
      const digest = hash(bytes);
      fs.writeFileSync(
        path.join(directory, layout, "blobs/sha256", digest.slice(7)),
        bytes,
      );
      return {
        mediaType:
          object.mediaType || "application/vnd.oci.image.config.v1+json",
        digest,
        size: bytes.length,
      };
    };
    const config = blob({
      os: "linux",
      architecture: "amd64",
      config: {
        Labels: {
          "org.opencontainers.image.revision": sourceSha,
          "org.opencontainers.image.version": version,
        },
      },
    });
    const descriptor = blob({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config,
      layers: [],
    });
    fs.writeFileSync(
      path.join(directory, layout, "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
    );
    fs.writeFileSync(
      path.join(directory, layout, "oci-layout"),
      '{"imageLayoutVersion":"1.0.0"}',
    );
    const smoke = Buffer.from(JSON.stringify({ image: name, passed: true }));
    fs.writeFileSync(path.join(directory, `${name}-smoke.json`), smoke);
    return {
      name,
      layout,
      digest: descriptor.digest,
      repository: `ghcr.io/${repository}/${name}`,
      platform: "linux/amd64",
      action: "built",
      content: { sourceSha, version },
      smoke: { path: `${name}-smoke.json`, sha256: hash(smoke) },
    };
  });
  const body = {
    schema: "kungfu-buildchain-oci-family/v1",
    repository,
    sourceSha,
    version,
    expectedImages: ["base", "child"],
    images,
  };
  const manifest = {
    ...body,
    root: v4ContentRoot("oci-publication-family", body),
  };
  const manifestPath = path.join(directory, "oci-family.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const requiredArtifactsPath = path.join(directory, "required.json");
  fs.writeFileSync(
    requiredArtifactsPath,
    JSON.stringify(
      images.map((i) => ({
        kind: "oci",
        name: i.repository,
        digest: i.digest,
        required: true,
      })),
    ),
  );
  return {
    directory,
    manifest,
    images,
    repository,
    sourceSha,
    version,
    manifestPath,
    requiredArtifactsPath,
  };
}
function provider(f, options = {}) {
  const tags = new Map(options.tags),
    blobs = new Set(),
    writes = [];
  let failOnce = options.failOnce;
  const fetchImpl = async (url, request) => {
    const location = new URL(url),
      method = request.method || "GET";
    if (location.pathname === "/token")
      return Response.json({ token: "fixture-registry-token" });
    const parts = location.pathname.match(
      /^\/v2\/(.+)\/(manifests|blobs)\/(.*)$/u,
    );
    assert.ok(parts, location.pathname);
    const [, repo, kind, ref] = parts;
    if (kind === "manifests") {
      const key = `${repo}:${ref}`;
      if (method === "GET")
        return tags.has(key)
          ? new Response(tags.get(key))
          : new Response(null, { status: 404 });
      assert.equal(method, "PUT");
      writes.push(key);
      tags.set(key, request.body);
      if (failOnce) {
        failOnce = false;
        throw new Error("lost response with sensitive fixture value");
      }
      return new Response(null, { status: 201 });
    }
    if (method === "HEAD")
      return new Response(null, { status: blobs.has(ref) ? 200 : 404 });
    if (method === "POST")
      return new Response(null, {
        status: 202,
        headers: {
          location:
            options.uploadLocation ||
            `${options.relativeLocation ? "" : "https://ghcr.io"}/v2/${repo}/blobs/${options.uploadPath || "uploads"}/fixture?state=opaque`,
        },
      });
    assert.equal(method, "PUT");
    assert.equal(location.searchParams.get("state"), "opaque");
    const chunks = [];
    for await (const chunk of request.body) chunks.push(chunk);
    assert.equal(
      hash(Buffer.concat(chunks)),
      location.searchParams.get("digest"),
    );
    blobs.add(location.searchParams.get("digest"));
    return new Response(null, { status: 201 });
  };
  const effect = {
    capabilityId: "product.oci.publish",
    adapter: "oci-image-family",
    targetRoot: "sha256:" + "1".repeat(64),
    subjectRoot: "sha256:" + "2".repeat(64),
  };
  const adapter = createOciPublicationAdapter({
    request: {
      actor: "fixture-user",
      sealedBundleManifest: f.manifestPath,
      sealedBundleRoot: f.directory,
      requiredArtifactsPath: f.requiredArtifactsPath,
      candidate: { source: { headSha: f.sourceSha } },
    },
    intent: {
      repository: f.repository,
      sourceSha: f.sourceSha,
      version: f.version,
      exactTag: `v${f.version}`,
      sealedBundleRoot: f.manifest.root,
    },
    plan: {
      operations: [
        {
          id: effect.capabilityId,
          adapter: effect.adapter,
          operationRoot: effect.targetRoot,
        },
      ],
    },
    fetchImpl,
    token: "fixture-write-token",
    evidenceDirectory: path.join(f.directory, "evidence"),
  });
  return { adapter, effect, writes, tags };
}

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
    await assert.rejects(p.adapter.apply(p.effect), /unsafe-registry-(upload-location|endpoint)/u);
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
