import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const OBSERVED_EVIDENCE_CONTRACT =
  "kungfu-buildchain-observed-evidence-bundle";

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function safeRelative(value, label) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes(".."))
    throw new Error(`invalid ${label}: ${value || "<empty>"}`);
  return normalized;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertHex(value, label) {
  if (!/^[0-9a-f]{64}$/.test(String(value || "")))
    throw new Error(`${label} must be a lowercase sha256 hex digest`);
}

function requiredHeader(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n]/.test(normalized))
    throw new Error(`${label} must be a non-empty single-line value`);
  return normalized;
}

function validatePublicationEntry({
  entry,
  kind,
  root,
  snapshotId,
  requireSnapshotDocument = false,
  requireHeaders = false,
}) {
  const source = safeRelative(entry.source, `${kind}.source`);
  const key = safeRelative(entry.key, `${kind}.key`);
  const file = path.resolve(root, source);
  if (file !== root && !file.startsWith(`${root}${path.sep}`))
    throw new Error(`${kind}.source escapes artifact root`);
  if (!fs.statSync(file).isFile())
    throw new Error(`${kind}.source is not a file: ${source}`);
  assertHex(entry.sha256, `${kind}.sha256`);
  const actual = sha256(file);
  if (actual !== entry.sha256)
    throw new Error(`${kind}.sha256 does not match ${source}`);
  if (requireSnapshotDocument) {
    const document = readJson(file);
    if (document.snapshotId !== snapshotId)
      throw new Error(`${kind} document snapshotId does not match manifest`);
  }
  return {
    kind,
    source,
    key,
    file,
    sha256: actual,
    contentType: requireHeaders
      ? requiredHeader(entry.contentType, `${kind}.contentType`)
      : String(entry.contentType || "application/json"),
    cacheControl: requireHeaders
      ? requiredHeader(entry.cacheControl, `${kind}.cacheControl`)
      : String(entry.cacheControl || ""),
  };
}

export function validateObservedEvidenceBundle({
  manifestPath,
  artifactRoot = path.dirname(manifestPath),
}) {
  const resolvedManifest = path.resolve(manifestPath);
  const root = path.resolve(artifactRoot);
  const manifest = readJson(resolvedManifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.contract !== OBSERVED_EVIDENCE_CONTRACT
  ) {
    throw new Error(
      `observed evidence manifest must be ${OBSERVED_EVIDENCE_CONTRACT} schemaVersion 1`,
    );
  }
  const snapshotId = String(manifest.snapshot?.id || "");
  if (!snapshotId || !/^[A-Za-z0-9._:+-]+$/.test(snapshotId))
    throw new Error("snapshot.id is invalid");
  if (!Number.isFinite(Date.parse(manifest.snapshot?.observedAt || "")))
    throw new Error("snapshot.observedAt must be ISO-8601");
  const immutable = manifest.publication?.immutable || {};
  const latest = manifest.publication?.latest || {};
  const immutableEntry = validatePublicationEntry({
    entry: immutable,
    kind: "immutable",
    root,
    snapshotId,
    requireSnapshotDocument: true,
  });
  const latestEntry = validatePublicationEntry({
    entry: latest,
    kind: "latest",
    root,
    snapshotId,
    requireSnapshotDocument: true,
  });
  const projectionInput = manifest.publication?.projections ?? [];
  if (!Array.isArray(projectionInput) || projectionInput.length > 16) {
    throw new Error(
      "publication.projections must be an array with at most 16 entries",
    );
  }
  const projections = projectionInput.map((entry, index) =>
    validatePublicationEntry({
      entry,
      kind: `projection[${index}]`,
      root,
      snapshotId,
      requireHeaders: true,
    }),
  );
  const entries = [immutableEntry, ...projections, latestEntry];
  if (!immutableEntry.key.includes(`/${snapshotId}.json`))
    throw new Error(
      "immutable key must bind snapshot.id below a versioned path",
    );
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error("immutable, projection, and latest keys must be unique");
  }
  const invalidationPaths = [
    ...new Set(manifest.publication?.invalidationPaths || []),
  ];
  if (
    invalidationPaths.some(
      (entry) =>
        typeof entry !== "string" ||
        !entry.startsWith("/") ||
        entry.includes(".."),
    )
  ) {
    throw new Error(
      "invalidation paths must be absolute viewer paths without traversal",
    );
  }
  return {
    manifest,
    manifestPath: resolvedManifest,
    artifactRoot: root,
    snapshotId,
    entries,
    immutable: immutableEntry,
    latest: latestEntry,
    projections,
    invalidationPaths,
  };
}
