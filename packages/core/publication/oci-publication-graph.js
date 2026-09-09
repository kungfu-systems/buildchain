import fs from "node:fs";

const imageTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const indexTypes = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
];
const composeType = "application/vnd.docker.compose.project";

export function ociPublicationTag(image, version) {
  return `${image.kind === "compose" ? "compose-" : ""}v${version}`;
}

export function verifyOciDestination(image, manifest, requireValue) {
  const compose = manifest.schema.endsWith("/v2") && image.kind === "compose";
  requireValue(
    manifest.schema.endsWith("/v2") || !image.kind,
    "artifact kinds require family v2",
  );
  const target =
    compose &&
    manifest.images.find(
      (entry) => entry.name === image.targetImage && entry.kind !== "compose",
    );
  requireValue(
    !image.kind || ["image", "compose"].includes(image.kind),
    "unsupported artifact kind",
  );
  requireValue(!compose || target, "Compose target image is absent");
  requireValue(
    image.repository ===
      `ghcr.io/${manifest.repository}/${compose ? target.name : image.name}`,
    "destination must belong to the consumer repository",
  );
  requireValue(
    manifest.images.filter(
      (entry) =>
        entry.repository === image.repository &&
        ociPublicationTag(entry, manifest.version) ===
          ociPublicationTag(image, manifest.version),
    ).length === 1,
    "duplicate publication destination",
  );
}

export function verifyOciGraph({
  image,
  manifest,
  descriptor,
  descriptorFile,
  requireValue: check,
  verifyProvenance,
}) {
  const manifests = [],
    blobs = new Map(),
    platforms = [],
    attestations = [];
  const visited = new Set();
  const read = (entry) => JSON.parse(fs.readFileSync(descriptorFile(entry)));
  function blob(entry) {
    descriptorFile(entry);
    blobs.set(entry.digest, entry);
  }
  function visit(entry, depth = 0) {
    check(
      depth < 4 && visited.size < 256 && !visited.has(entry.digest),
      "duplicate or excessive OCI graph",
    );
    visited.add(entry.digest);
    const document = read(entry);
    check(
      document.schemaVersion === 2 && document.mediaType === entry.mediaType,
      "OCI descriptor media type mismatch",
    );
    if (indexTypes.includes(document.mediaType)) {
      check(
        image.kind !== "compose" &&
          Array.isArray(document.manifests) &&
          document.manifests.length > 0,
        "invalid OCI index",
      );
      for (const child of document.manifests) visit(child, depth + 1);
    } else {
      check(
        imageTypes.includes(document.mediaType) &&
          Array.isArray(document.layers),
        "unsupported OCI manifest",
      );
      const config = read(document.config);
      blob(document.config);
      for (const layer of document.layers) blob(layer);
      if (image.kind === "compose") {
        verifyCompose(document, image, manifest, read, check);
      } else if (
        entry.annotations?.["vnd.docker.reference.type"] ===
        "attestation-manifest"
      ) {
        check(
          entry.platform?.os === "unknown" &&
            entry.platform?.architecture === "unknown" &&
            document.layers.length > 0 &&
            document.layers.every(
              (layer) => layer.mediaType === "application/vnd.in-toto+json",
            ),
          "invalid image attestation",
        );
        attestations.push({
          target: entry.annotations["vnd.docker.reference.digest"],
          statements: document.layers.map(read),
        });
      } else {
        const platform = `${config.os}/${config.architecture}`;
        check(
          /^linux\/(amd64|arm64)$/u.test(platform) &&
            (!entry.platform ||
              platform ===
                `${entry.platform.os}/${entry.platform.architecture}`),
          "OCI platform mismatch",
        );
        check(
          !platforms.some((found) => found.platform === platform),
          "duplicate image platform",
        );
        platforms.push({ platform, digest: entry.digest });
        verifyProvenance(config);
      }
    }
    manifests.push(entry);
  }
  visit(descriptor);
  if (image.kind !== "compose") {
    const expected =
      image.platform === "multi-platform" ? image.platforms : [image.platform];
    check(
      Array.isArray(expected) &&
        expected.length > 0 &&
        new Set(expected).size === expected.length &&
        JSON.stringify([...expected].sort()) ===
          JSON.stringify(platforms.map((entry) => entry.platform).sort()),
      "incomplete image platform family",
    );
    for (const attestation of attestations) {
      check(
        platforms.some((entry) => entry.digest === attestation.target) &&
          attestation.statements.every((statement) =>
            statement.subject?.some(
              (subject) =>
                `sha256:${subject.digest?.sha256}` === attestation.target,
            ),
          ),
        "image attestation subject mismatch",
      );
    }
  }
  return { manifests, blobs: [...blobs.values()], platforms };
}

function verifyCompose(document, image, manifest, read, check) {
  if (image.preview)
    check(
      image.preview.alias === "compose-preview" &&
        /^\.github\/workflows\/[a-z0-9-]+\.yml$/u.test(
          image.preview.qualificationWorkflow,
        ) &&
        /^(none|sha256:[0-9a-f]{64})$/u.test(image.preview.previousDigest),
      "invalid Compose preview policy",
    );
  check(
    image.platform === "compose" &&
      document.artifactType === composeType &&
      document.config.mediaType === "application/vnd.oci.empty.v1+json" &&
      document.layers.length === 1 &&
      document.layers[0].mediaType ===
        "application/vnd.docker.compose.file+yaml",
    "unsupported Compose artifact",
  );
  // JSON is a YAML subset; this bounded public form needs no executable YAML loader.
  const project = read(document.layers[0]);
  check(
    project.services && Object.keys(project.services).length > 0,
    "empty Compose application",
  );
  const target = manifest.images.find(
    (entry) => entry.name === image.targetImage,
  );
  const references = Object.values(project.services).map(
    (service) => service.image,
  );
  check(
    references.every(
      (ref) =>
        typeof ref === "string" &&
        /^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/u.test(ref),
    ) && references.includes(`${target.repository}@${target.digest}`),
    "Compose images must bind exact digests",
  );
  check(
    image.content?.sourceSha === manifest.sourceSha &&
      image.content?.version === manifest.version &&
      image.action === "built",
    "Compose candidate provenance mismatch",
  );
}
