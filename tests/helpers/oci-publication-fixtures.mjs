import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { domainContentRoot } from "../../packages/core/contracts/canonical-contracts.js";
import { verifyOciPublicationBundle } from "../../packages/core/publication/oci-publication-bundle.js";
import { createOciPublicationAdapter } from "../../packages/core/release/promote-candidate/oci-provider.js";

export const hash = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
export function fixture(t) {
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
    root: domainContentRoot("oci-publication-family", body),
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
export function provider(f, options = {}) {
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

export function compoundFixture(t, withAttestation = false) {
  const f = fixture(t);
  const [image, compose] = f.images;
  function blob(entry, value, mediaType = value.mediaType) {
    const bytes = Buffer.from(JSON.stringify(value)),
      digest = hash(bytes);
    fs.writeFileSync(
      path.join(f.directory, entry.layout, "blobs/sha256", digest.slice(7)),
      bytes,
    );
    return { mediaType, digest, size: bytes.length };
  }
  const old = JSON.parse(
    fs.readFileSync(path.join(f.directory, image.layout, "index.json")),
  ).manifests[0];
  old.platform = { os: "linux", architecture: "amd64" };
  const armConfig = blob(
    image,
    {
      os: "linux",
      architecture: "arm64",
      config: {
        Labels: {
          "org.opencontainers.image.revision": f.sourceSha,
          "org.opencontainers.image.version": f.version,
        },
      },
    },
    "application/vnd.oci.image.config.v1+json",
  );
  const arm = {
    ...blob(image, {
      schemaVersion: 2,
      mediaType: old.mediaType,
      config: armConfig,
      layers: [],
    }),
    platform: { os: "linux", architecture: "arm64" },
  };
  const members = [old, arm];
  if (withAttestation) {
    const config = blob(image, {}, "application/vnd.oci.empty.v1+json");
    config.data = Buffer.from("{}").toString("base64");
    members.push({
      ...blob(image, {
        schemaVersion: 2,
        mediaType: old.mediaType,
        config,
        layers: [
          blob(
            image,
            {
              _type: "https://in-toto.io/Statement/v0.1",
              subject: [
                { name: "fixture", digest: { sha256: old.digest.slice(7) } },
              ],
              predicateType: "https://slsa.dev/provenance/v0.2",
              predicate: {},
            },
            "application/vnd.in-toto+json",
          ),
        ],
      }),
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": old.digest,
      },
    });
  }
  const index = blob(image, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: members,
  });
  image.digest = index.digest;
  image.platform = "multi-platform";
  image.platforms = ["linux/amd64", "linux/arm64"];
  fs.writeFileSync(
    path.join(f.directory, image.layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [index] }),
  );
  const config = blob(compose, {}, "application/vnd.oci.empty.v1+json");
  const layer = blob(
    compose,
    { services: { app: { image: `${image.repository}@${image.digest}` } } },
    "application/vnd.docker.compose.file+yaml",
  );
  const application = blob(compose, {
    schemaVersion: 2,
    mediaType: old.mediaType,
    artifactType: "application/vnd.docker.compose.project",
    config,
    layers: [layer],
  });
  Object.assign(compose, {
    kind: "compose",
    targetImage: image.name,
    platform: "compose",
    repository: image.repository,
    digest: application.digest,
  });
  fs.writeFileSync(
    path.join(f.directory, compose.layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [application] }),
  );
  f.manifest.schema = "kungfu-buildchain-oci-family/v2";
  f.reseal = () => {
    const { root, ...body } = f.manifest;
    f.manifest.root = domainContentRoot("oci-publication-family", body);
    fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    fs.writeFileSync(
      f.requiredArtifactsPath,
      JSON.stringify(
        f.images.map((i) => ({
          kind: "oci",
          name: i.repository,
          digest: i.digest,
          required: true,
        })),
      ),
    );
  };
  f.reseal();
  f.verify = () =>
    verifyOciPublicationBundle({
      bundleRoot: f.directory,
      manifest: f.manifest,
      repository: f.repository,
      sourceSha: f.sourceSha,
      version: f.version,
    });
  return { ...f, blob, armConfig, index, application, layer };
}
