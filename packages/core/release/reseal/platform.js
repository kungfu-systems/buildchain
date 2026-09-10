import fs from "node:fs";
import path from "node:path";
import { normalizeTailResealRequest } from "../tail-reseal.js";
import { domainContentRoot } from "../../contracts/canonical-contracts.js";
import { readJson, required, sha256File } from "./files.js";
function locateManifest(root, platformId) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === "manifest.json") {
        const value = readJson(absolute);
        if (
          value?.contract === "kungfu-buildchain-artifact" &&
          value?.platform?.id === platformId
        )
          matches.push({ absolute, value });
      }
    }
  };
  visit(root);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${platformId} manifest under ${root}, found ${matches.length}`,
    );
  return matches[0];
}

function resolvePayload(root, relative, platformId) {
  const absolute = path.resolve(root, relative);
  if (
    !absolute.startsWith(`${root}${path.sep}`) ||
    !fs.existsSync(absolute) ||
    !fs.statSync(absolute).isFile() ||
    !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)
  )
    throw new Error(`${platformId} manifest file is missing: ${relative}`);
  return absolute;
}

export function verifyTailResealPlatform({
  request,
  platformId,
  artifactRoot,
  mode = "retained",
  providerReadbackRoot = null,
} = {}) {
  const normalized = normalizeTailResealRequest(request);
  const platform = normalized.platforms.find(({ id }) => id === platformId);
  if (!platform)
    throw new Error(`tail reseal request does not bind platform ${platformId}`);
  if (!new Set(["retained", "resealed"]).has(mode))
    throw new Error(
      "tail reseal verification mode must be retained or resealed",
    );
  if (mode === "resealed" && platformId !== "macos-arm64")
    throw new Error("only macos-arm64 may produce a resealed byte set");
  const root = path.resolve(artifactRoot || ".");
  const { absolute: manifestPath, value: manifest } = locateManifest(
    root,
    platformId,
  );
  if (manifest.artifactName !== platform.artifactName)
    throw new Error(`${platformId} manifest artifact name mismatch`);
  if (
    manifest.git?.repository !== normalized.repository ||
    manifest.git?.sha !== normalized.source.sha ||
    manifest.git?.treeSha !== normalized.source.treeSha
  )
    throw new Error(`${platformId} manifest source mismatch`);
  if (
    Number(manifest.git?.runId) !== normalized.source.runId ||
    Number(manifest.git?.runAttempt) !== normalized.source.runAttempt
  )
    throw new Error(`${platformId} manifest original run mismatch`);
  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .map((file, index) => {
      const relative = required(
        file.path || file.name,
        `${platformId} manifest files[${index}] path`,
      );
      const absolute = resolvePayload(root, relative, platformId);
      const size = fs.statSync(absolute).size;
      if (Number(file.size ?? file.bytes) !== size)
        throw new Error(
          `${platformId} manifest file size mismatch: ${relative}`,
        );
      const digest = sha256File(absolute);
      const expected = `sha256:${String(file.sha256 || "").replace(/^sha256:/u, "")}`;
      if (digest !== expected)
        throw new Error(
          `${platformId} manifest file digest mismatch: ${relative}`,
        );
      return { path: relative, size, digest };
    })
    .sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
  if (files.length === 0)
    throw new Error(`${platformId} manifest has no retained files`);
  const observedArtifactRoot = domainContentRoot(
    "tail-reseal-artifact-files",
    files,
  );
  const observedManifestRoot = sha256File(manifestPath);
  const retained = mode === "retained";
  if (
    retained &&
    (observedArtifactRoot !== platform.artifactRoot ||
      observedManifestRoot !== platform.manifestRoot)
  )
    throw new Error(
      `${platformId} retained artifact or manifest root mismatch`,
    );
  if (!retained) {
    if (
      observedArtifactRoot === platform.artifactRoot ||
      observedManifestRoot === platform.manifestRoot
    )
      throw new Error(
        "macos-arm64 reseal did not produce a distinct signed manifest",
      );
    if (providerReadbackRoot !== normalized.signing.providerReadbackRoot)
      throw new Error("macos-arm64 provider readback root mismatch");
  }
  return {
    platformId,
    artifactRoot: observedArtifactRoot,
    manifestRoot: observedManifestRoot,
    capsuleRoot: platform.capsuleRoot,
    byteIdentical: retained,
    providerReadbackRoot: retained ? null : providerReadbackRoot,
  };
}
