import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  ociBundleFile,
  verifyOciPublicationBundle,
} from "../../packages/core/oci-publication-bundle.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";

const accept =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
function fault(code, kind = "conflict") {
  return Object.assign(new Error(`OCI publication: ${code}`), {
    releaseTailClass: kind,
    releaseTailCode: code,
  });
}

function createRegistryClient(token, fetchImpl, actor) {
  const credentials = new Map();
  async function credential(repository, write) {
    const key = `${repository}:${write}`;
    if (credentials.has(key)) return credentials.get(key);
    if (write && (!token || !actor))
      throw fault("missing-registry-write-identity");
    const url = new URL("https://ghcr.io/token");
    url.searchParams.set("service", "ghcr.io");
    url.searchParams.set(
      "scope",
      `repository:${repository}:${write ? "pull,push" : "pull"}`,
    );
    const headers = write
      ? {
          authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}`,
        }
      : {};
    const response = await send(url, { headers });
    if (!response.ok) throw fault("registry-token-unavailable", "transient");
    const value = (await response.json()).token;
    if (typeof value !== "string" || !value)
      throw fault("registry-token-invalid");
    credentials.set(key, value);
    return value;
  }
  async function send(url, options = {}) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      target.host !== "ghcr.io" ||
      target.username ||
      target.password
    )
      throw fault("unsafe-registry-endpoint");
    try {
      return await fetchImpl(target, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      throw fault("registry-transport-uncertain", "transient");
    }
  }
  async function registry(
    image,
    suffix,
    { write = false, method = "GET", body, headers = {} } = {},
  ) {
    const repository = image.repository.slice("ghcr.io/".length);
    const auth = await credential(repository, write);
    return send(`https://ghcr.io/v2/${repository}/${suffix}`, {
      method,
      headers: { ...headers, authorization: `Bearer ${auth}` },
      ...(body ? { body, duplex: "half" } : {}),
    });
  }
  return { registry, send, credential };
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
  async function observedImage(image, write) {
    const response = await registry(image, `manifests/${intent.exactTag}`, {
      write,
      headers: { accept },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw fault("registry-readback-unavailable", "transient");
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
    if (
      digest !== image.digest ||
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
    const bytes = fs.readFileSync(digestPath(image.digest));
    const document = JSON.parse(bytes);
    for (const blob of [document.config, ...document.layers]) {
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
      if (!location.pathname.startsWith(`/v2/${repository}/blobs/uploads/`))
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
    // Recheck immediately before the immutable tag write; no existing tag is replaced.
    if (await observedImage(image, true)) return;
    const result = await registry(image, `manifests/${intent.exactTag}`, {
      write: true,
      method: "PUT",
      body: bytes,
      headers: {
        "content-type": document.mediaType,
        "content-length": String(bytes.length),
      },
    });
    if (result.status !== 201)
      throw fault("registry-manifest-write-uncertain", "transient");
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
      if (!(await observedImage(image, false)))
        throw fault("image-not-anonymously-readable", "transient");
    }
    const evidence = {
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
        ref: intent.exactTag,
        anonymous: true,
        smoke: image.smoke,
      })),
    };
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
