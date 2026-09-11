import { createRegistryClient } from "./oci-registry-client.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  ociBundleFile,
  verifyOciPublicationBundle,
} from "../../publication/oci-publication-bundle.js";
import { ociPublicationTag } from "../../publication/oci-publication-graph.js";
import { releaseTailRoot } from "../release-tail-provider-plane.js";

const accept =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
function fault(code, kind = "conflict") {
  return Object.assign(new Error(`OCI publication: ${code}`), {
    releaseTailClass: kind,
    releaseTailCode: code,
  });
}

function verifiedProviderBundle(request, intent) {
  const manifest = JSON.parse(fs.readFileSync(request.sealedBundleManifest));
  const bundle = verifyOciPublicationBundle({
    bundleRoot: request.sealedBundleRoot,
    manifest,
    repository: intent.repository,
    sourceSha: request.candidate.source.headSha,
    version: intent.version,
  });
  if (bundle.root !== intent.sealedBundleRoot)
    throw fault("sealed-family-root-mismatch");
  const required = JSON.parse(
    fs.readFileSync(request.requiredArtifactsPath),
  ).filter((a) => a.kind === "oci" && a.required !== false);
  if (
    JSON.stringify(required.map((a) => `${a.name}@${a.digest}`).sort()) !==
    JSON.stringify(
      manifest.images.map((i) => `${i.repository}@${i.digest}`).sort(),
    )
  )
    throw fault("required-family-mismatch");
  return { manifest, bundle };
}

export function createOciPublicationAdapter({
  request,
  intent,
  plan,
  fetchImpl = fetch,
  token,
  evidenceDirectory = ".buildchain/release-tail",
}) {
  const { manifest, bundle } = verifiedProviderBundle(request, intent);
  const { registry, send, credential } = createRegistryClient(
    token,
    fetchImpl,
    request.actor,
  );
  async function observedImage(
    image,
    write,
    ref = ociPublicationTag(image, intent.version),
    expected = image.digest,
  ) {
    const response = await registry(image, `manifests/${ref}`, {
      write,
      headers: { accept },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw fault("registry-readback-unavailable", "transient");
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (
      digest !== expected ||
      (response.headers.get("docker-content-digest") || digest) !== digest
    )
      throw fault("immutable-image-tag-conflict");
    return true;
  }
  function bind(effect) {
    const operation = plan.operations.find((o) => o.id === effect.capabilityId);
    if (
      !operation ||
      operation.adapter !== "oci-image-family" ||
      operation.operationRoot !== effect.targetRoot
    )
      throw fault("rooted-oci-operation-mismatch");
  }
  async function upload(image) {
    const digestPath = (digest) =>
      ociBundleFile(
        bundle.bundleRoot,
        `${image.layout}/blobs/sha256/${digest.slice(7)}`,
      );
    const graph = bundle.graphs.get(image.name);
    for (const blob of graph.blobs) {
      const exists = await registry(image, `blobs/${blob.digest}`, {
        write: true,
        method: "HEAD",
      });
      if (exists.ok) continue;
      if (exists.status !== 404)
        throw fault("registry-blob-readback-unavailable", "transient");
      const start = await registry(image, "blobs/uploads/", {
        write: true,
        method: "POST",
      });
      if (start.status !== 202 || !start.headers.get("location"))
        throw fault("registry-upload-start-uncertain", "transient");
      const location = new URL(
        start.headers.get("location"),
        "https://ghcr.io",
      );
      const repository = image.repository.slice("ghcr.io/".length);
      if (
        location.pathname.match(
          /^\/v2\/(.+)\/blobs\/uploads?\/[^/]+$/u,
        )?.[1] !== repository
      )
        throw fault("unsafe-registry-upload-location");
      if (
        location.protocol !== "https:" ||
        location.host !== "ghcr.io" ||
        location.username ||
        location.password
      )
        throw fault("unsafe-registry-endpoint");
      location.searchParams.set("digest", blob.digest);
      const stream = fs.createReadStream(digestPath(blob.digest));
      const closed = finished(stream).catch(() => {});
      let response;
      try {
        response = await send(location, {
          method: "PUT",
          duplex: "half",
          body: stream,
          headers: {
            authorization: `Bearer ${await credential(repository, true)}`,
            "content-type": "application/octet-stream",
            "content-length": String(blob.size),
          },
        });
      } finally {
        stream.destroy();
        await closed;
      }
      if (response.status !== 201)
        throw fault("registry-upload-uncertain", "transient");
    }
    for (const descriptor of graph.manifests) {
      const ref =
        descriptor.digest === image.digest
          ? ociPublicationTag(image, intent.version)
          : descriptor.digest;
      // Recheck immediately before each content-addressed or immutable tag write.
      if (await observedImage(image, true, ref, descriptor.digest)) continue;
      const bytes = fs.readFileSync(digestPath(descriptor.digest));
      const result = await registry(image, `manifests/${ref}`, {
        write: true,
        method: "PUT",
        body: bytes,
        headers: {
          "content-type": descriptor.mediaType,
          "content-length": String(bytes.length),
        },
      });
      if (result.status !== 201)
        throw fault("registry-manifest-write-uncertain", "transient");
    }
  }
  async function readback(effect) {
    bind(effect);
    for (const image of manifest.images) {
      if (!(await observedImage(image, true)))
        return {
          outcome: "absent",
          providerCode: "oci-family-incomplete",
          evidenceRoots: [],
        };
      for (const descriptor of bundle.graphs.get(image.name).manifests) {
        const ref =
          descriptor.digest === image.digest
            ? ociPublicationTag(image, intent.version)
            : descriptor.digest;
        if (!(await observedImage(image, false, ref, descriptor.digest)))
          throw fault("image-not-anonymously-readable", "transient");
      }
    }
    const evidence = publicationReadback(manifest, bundle, intent);
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDirectory, "oci-publication-readback.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    return {
      outcome: "observed",
      subjectRoot: effect.subjectRoot,
      targetRoot: effect.targetRoot,
      providerCode: "oci-family-publicly-verified",
      evidenceRoots: [releaseTailRoot(evidence)],
    };
  }
  return {
    readback,
    async apply(effect) {
      bind(effect);
      // Check the whole family for conflicts before the first provider mutation.
      const present = await Promise.all(
        manifest.images.map((image) => observedImage(image, true)),
      );
      for (const [index, image] of manifest.images.entries())
        if (!present[index]) await upload(image);
      return readback(effect);
    },
  };
}

function publicationReadback(manifest, bundle, intent) {
  return {
    schema: "kungfu-buildchain-oci-publication-readback/v1",
    familyRoot: bundle.root,
    sourceSha: intent.sourceSha,
    candidateSourceSha: manifest.sourceSha,
    version: intent.version,
    images: manifest.images.map((image) => ({
      name: image.name,
      repository: image.repository,
      digest: image.digest,
      platform: image.platform,
      action: image.action,
      content: image.content,
      contractMajor: image.contractMajor ?? null,
      parentDigest: image.parentDigest ?? null,
      ref: ociPublicationTag(image, intent.version),
      ...(image.platforms ? { platforms: image.platforms } : {}),
      anonymous: true,
      smoke: image.smoke,
    })),
  };
}
