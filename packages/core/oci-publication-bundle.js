import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { v4ContentRoot } from "./v4-canonical-contracts.js";
import {
  verifyOciGraph,
  verifyOciDestination,
} from "./oci-publication-graph.js";

export const OCI_FAMILY_SCHEMA = "kungfu-buildchain-oci-family/v1";
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const namePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export function sealOciPublicationBundle({ bundleRoot, body }) {
  const manifest = {
    ...body,
    root: v4ContentRoot("oci-publication-family", body),
  };
  verifyOciPublicationBundle({
    bundleRoot,
    manifest,
    repository: body.repository,
    sourceSha: body.sourceSha,
    version: body.version,
  });
  return manifest;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(`OCI bundle: ${message}`);
}

export function ociBundleFile(root, relative) {
  requireValue(
    typeof relative === "string" &&
      relative.length > 0 &&
      !relative.includes("\\") &&
      !path.isAbsolute(relative) &&
      !relative.split(/[\\/]/u).some((p) => p === ".." || p === "." || !p),
    "unsafe file path",
  );
  const base = fs.realpathSync(root);
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    requireValue(
      !fs.lstatSync(current).isSymbolicLink(),
      "symlinks are forbidden",
    );
  }
  requireValue(
    fs.statSync(current).isFile() &&
      fs.realpathSync(current).startsWith(`${base}${path.sep}`),
    "file escapes bundle",
  );
  return current;
}

function fileDigest(file) {
  const hash = crypto.createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (;;) {
      const size = fs.readSync(fd, buffer);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
}

function verifyImageProvenance(image, config, sourceSha, version) {
  const labels = config.config?.Labels || {};
  requireValue(
    image.content &&
      /^[0-9a-f]{40}$/u.test(image.content.sourceSha) &&
      typeof image.content.version === "string" &&
      image.content.version.length > 0,
    "missing image content provenance",
  );
  requireValue(
    labels["org.opencontainers.image.revision"] === image.content.sourceSha &&
      labels["org.opencontainers.image.version"] === image.content.version,
    "image content provenance mismatch",
  );
  if (image.action === "built")
    requireValue(
      image.content.sourceSha === sourceSha &&
        image.content.version === version,
      "built image is not from the candidate source",
    );
  if (image.contractMajor !== undefined)
    requireValue(
      Number.isInteger(image.contractMajor) &&
        image.contractMajor > 0 &&
        labels["io.kungfu.image.contract-major"] ===
          String(image.contractMajor),
      "image contract major mismatch",
    );
  if (image.parentDigest)
    requireValue(
      digestPattern.test(image.parentDigest) &&
        labels["io.kungfu.image.parent-digest"] === image.parentDigest,
      "image parent digest mismatch",
    );
  if (image.content.materialSha)
    requireValue(
      /^[0-9a-f]{40}$/u.test(image.content.materialSha) &&
        labels["io.kungfu.buildchain.release-material-sha"] ===
          image.content.materialSha,
      "image material provenance mismatch",
    );
}

export function verifyOciPublicationBundle({
  bundleRoot,
  manifest,
  repository,
  sourceSha,
  version,
}) {
  requireValue(
    [OCI_FAMILY_SCHEMA, "kungfu-buildchain-oci-family/v2"].includes(
      manifest?.schema,
    ),
    "unsupported manifest schema",
  );
  const { root, ...body } = manifest;
  const computed = v4ContentRoot("oci-publication-family", body);
  requireValue(root === computed, "manifest root mismatch");
  requireValue(
    manifest.repository === repository &&
      manifest.sourceSha === sourceSha &&
      manifest.version === version,
    "candidate identity mismatch",
  );
  requireValue(
    /^[a-z0-9-]+\/[a-z0-9._-]+$/u.test(repository),
    "invalid repository",
  );
  requireValue(
    Array.isArray(manifest.images) && manifest.images.length > 0,
    "empty image family",
  );
  const expected = manifest.expectedImages;
  requireValue(
    Array.isArray(expected) &&
      expected.length === new Set(expected).size &&
      expected.every((n) => namePattern.test(n)),
    "invalid expected image family",
  );
  const actual = manifest.images.map((i) => i.name).sort();
  requireValue(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    "incomplete or duplicate image family",
  );
  const files = new Map();
  const graphs = new Map();
  for (const image of manifest.images) {
    verifyOciDestination(image, manifest, requireValue);
    requireValue(
      digestPattern.test(image.digest) &&
        ["built", "reused"].includes(image.action),
      "invalid image identity",
    );
    requireValue(
      /^linux\/(amd64|arm64)$/u.test(image.platform) ||
        (manifest.schema.endsWith("/v2") &&
          ["multi-platform", "compose"].includes(image.platform)),
      "unsupported image platform",
    );
    const prefix = image.layout;
    const descriptorFile = (descriptor) => {
      requireValue(
        digestPattern.test(descriptor.digest) &&
          Number.isSafeInteger(descriptor.size) &&
          descriptor.size >= 0 &&
          !descriptor.urls,
        "invalid OCI descriptor",
      );
      const relative = `${prefix}/blobs/sha256/${descriptor.digest.slice(7)}`;
      const file = ociBundleFile(bundleRoot, relative);
      requireValue(
        fs.statSync(file).size === descriptor.size,
        "OCI blob size mismatch",
      );
      if (!files.has(file))
        requireValue(
          fileDigest(file) === descriptor.digest,
          "OCI blob digest mismatch",
        );
      if (Object.hasOwn(descriptor, "data")) {
        requireValue(
          descriptor.size <= 1024 * 1024 &&
            descriptor.data === fs.readFileSync(file).toString("base64"),
          "embedded OCI content mismatch",
        );
      }
      files.set(file, descriptor);
      return file;
    };
    const layout = JSON.parse(
      fs.readFileSync(ociBundleFile(bundleRoot, `${prefix}/oci-layout`)),
    );
    requireValue(
      layout.imageLayoutVersion === "1.0.0",
      "unsupported OCI layout",
    );
    const index = JSON.parse(
      fs.readFileSync(ociBundleFile(bundleRoot, `${prefix}/index.json`)),
    );
    const selected = (index.manifests || []).filter(
      (descriptor) =>
        descriptor.digest === image.digest &&
        (descriptor.annotations?.["org.opencontainers.image.ref.name"] ===
          image.name ||
          index.manifests.length === 1),
    );
    requireValue(
      index.schemaVersion === 2 && selected.length === 1,
      "OCI index must select one exact image manifest",
    );
    if (manifest.schema.endsWith("/v2")) {
      graphs.set(
        image.name,
        verifyOciGraph({
          image,
          manifest,
          descriptor: selected[0],
          descriptorFile,
          requireValue,
          verifyProvenance: (config) =>
            verifyImageProvenance(image, config, sourceSha, version),
        }),
      );
    } else {
      const document = JSON.parse(fs.readFileSync(descriptorFile(selected[0])));
      requireValue(
        document.schemaVersion === 2 &&
          [
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
          ].includes(document.mediaType) &&
          Array.isArray(document.layers),
        "unsupported OCI image manifest",
      );
      const config = JSON.parse(
        fs.readFileSync(descriptorFile(document.config)),
      );
      requireValue(
        `${config.os}/${config.architecture}` === image.platform,
        "OCI platform mismatch",
      );
      verifyImageProvenance(image, config, sourceSha, version);
      for (const layer of document.layers) descriptorFile(layer);
      graphs.set(image.name, {
        manifests: [selected[0]],
        blobs: [document.config, ...document.layers],
      });
    }
    const smokeFile = ociBundleFile(bundleRoot, image.smoke.path);
    requireValue(
      fileDigest(smokeFile) === image.smoke.sha256,
      "smoke evidence digest mismatch",
    );
    const smoke = JSON.parse(fs.readFileSync(smokeFile));
    requireValue(
      smoke.passed === true && smoke.image === image.name,
      "smoke qualification failed",
    );
  }
  return {
    root: computed,
    manifest,
    graphs,
    bundleRoot: fs.realpathSync(bundleRoot),
  };
}
