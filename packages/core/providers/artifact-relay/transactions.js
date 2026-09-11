import fs from "node:fs";
import path from "node:path";
import {
  toPosix,
  sha256File,
  collectGroupFiles,
  safeSegment,
  normalizePrefix,
  assertSafeRelativePath,
} from "./files.js";
const CONTRACT = "kungfu-buildchain-artifact-relay-s3";

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function uploadRelayArtifacts({
  workspace,
  manifestPath,
  bucket,
  region,
  prefix,
  groups,
  repository,
  runId,
  runAttempt,
  sourceSha,
  platformId,
  platformName,
  client,
} = {}) {
  if (!bucket) throw new Error("BUILDCHAIN_ARTIFACT_RELAY_BUCKET is required");
  if (!region) throw new Error("BUILDCHAIN_ARTIFACT_RELAY_REGION is required");
  const resolvedWorkspace = path.resolve(workspace);
  const basePrefix = [
    normalizePrefix(prefix),
    safeSegment(repository || "repository"),
    safeSegment(runId || "run"),
    safeSegment(runAttempt || "attempt"),
    safeSegment(sourceSha || "sha"),
    safeSegment(platformId || "platform"),
  ].join("/");
  const manifestGroups = [];

  for (const group of groups) {
    const artifactName = String(group.artifactName || "").trim();
    if (!artifactName) {
      throw new Error(`relay ${group.role} artifact name is required`);
    }
    const files = collectGroupFiles(resolvedWorkspace, group.paths || []);
    if (group.required && files.length === 0) {
      throw new Error(
        `relay ${group.role} artifact ${artifactName} matched no files`,
      );
    }
    const groupPrefix = `${basePrefix}/${safeSegment(group.role)}/${safeSegment(artifactName)}`;
    const objects = [];
    for (const file of files) {
      const relativePath = assertSafeRelativePath(
        toPosix(path.relative(resolvedWorkspace, file)),
      );
      const stat = fs.statSync(file);
      const sha256 = sha256File(file);
      const key = `${groupPrefix}/${relativePath}`;
      await client.put({
        bucket,
        key,
        region,
        filePath: file,
        sha256,
        size: stat.size,
      });
      objects.push({
        relativePath,
        size: stat.size,
        sha256,
        bucket,
        key,
        uri: `s3://${bucket}/${key}`,
      });
    }
    manifestGroups.push({
      role: group.role,
      artifactName,
      fileCount: objects.length,
      totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
      objects,
    });
  }

  const manifest = {
    schemaVersion: 1,
    contract: CONTRACT,
    transferMode: "s3-to-github-artifacts",
    provider: "s3",
    generatedAt: new Date().toISOString(),
    repository,
    runId,
    runAttempt,
    sourceSha,
    platform: {
      id: platformId,
      name: platformName,
    },
    s3: {
      bucket,
      region,
      prefix: basePrefix,
    },
    groups: manifestGroups,
  };
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
  writeManifest(resolvedManifestPath, manifest);
  const outputs = {
    "relay-manifest-path": toPosix(
      path.relative(resolvedWorkspace, resolvedManifestPath),
    ),
    "relay-object-count": String(
      manifestGroups.reduce((sum, group) => sum + group.fileCount, 0),
    ),
    "relay-total-bytes": String(
      manifestGroups.reduce((sum, group) => sum + group.totalBytes, 0),
    ),
  };
  return { manifest, outputs };
}

function findRelayManifest(inputRoot, expectedPlatformId = "") {
  const matches = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const current = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(current);
      } else if (entry.name === "relay-manifest.json") {
        const manifest = JSON.parse(fs.readFileSync(current, "utf8"));
        if (
          manifest.contract === CONTRACT &&
          (!expectedPlatformId || manifest.platform?.id === expectedPlatformId)
        ) {
          matches.push({ path: current, manifest });
        }
      }
    }
  }
  walk(path.resolve(inputRoot));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one relay-manifest.json${expectedPlatformId ? ` for ${expectedPlatformId}` : ""}, found ${matches.length}`,
    );
  }
  return matches[0];
}

export async function downloadRelayArtifacts({
  inputRoot,
  outputRoot,
  region,
  platformId,
  client,
} = {}) {
  const { manifest } = findRelayManifest(inputRoot, platformId);
  const resolvedOutputRoot = path.resolve(outputRoot);
  const effectiveRegion = region || manifest.s3?.region || "";
  if (!effectiveRegion) {
    throw new Error("relay download region is required");
  }
  const outputs = {};
  let objectCount = 0;
  let totalBytes = 0;
  for (const group of manifest.groups || []) {
    const groupDir = path.join(resolvedOutputRoot, safeSegment(group.role));
    fs.mkdirSync(groupDir, { recursive: true });
    for (const object of group.objects || []) {
      const relativePath = assertSafeRelativePath(object.relativePath);
      const targetPath = path.join(groupDir, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      await client.get({
        bucket: object.bucket,
        key: object.key,
        region: effectiveRegion,
        targetPath,
      });
      const actualSha256 = sha256File(targetPath);
      if (actualSha256 !== object.sha256) {
        throw new Error(
          `relay sha256 mismatch for ${relativePath}: expected ${object.sha256}, got ${actualSha256}`,
        );
      }
      objectCount += 1;
      totalBytes += Number(object.size || 0);
    }
    outputs[`${group.role}-path`] = toPosix(
      path.relative(resolvedOutputRoot, groupDir),
    );
    outputs[`${group.role}-artifact-name`] = group.artifactName || "";
  }
  const downloadedManifestPath = path.join(
    resolvedOutputRoot,
    "relay-manifest.downloaded.json",
  );
  writeManifest(downloadedManifestPath, {
    ...manifest,
    downloadedAt: new Date().toISOString(),
    downloadedObjectCount: objectCount,
    downloadedTotalBytes: totalBytes,
  });
  return {
    manifest,
    objectCount,
    totalBytes,
    outputs: {
      ...outputs,
      "relay-downloaded-manifest-path": toPosix(
        path.relative(resolvedOutputRoot, downloadedManifestPath),
      ),
      "relay-downloaded-object-count": String(objectCount),
      "relay-downloaded-total-bytes": String(totalBytes),
    },
  };
}

export async function cleanupRelayArtifacts({
  inputRoot,
  region,
  platformId,
  client,
} = {}) {
  const { manifest } = findRelayManifest(inputRoot, platformId);
  const effectiveRegion = region || manifest.s3?.region || "";
  if (!effectiveRegion) {
    throw new Error("relay cleanup region is required");
  }
  let objectCount = 0;
  let totalBytes = 0;
  for (const group of manifest.groups || []) {
    for (const object of group.objects || []) {
      await client.delete({
        bucket: object.bucket,
        key: object.key,
        region: effectiveRegion,
      });
      objectCount += 1;
      totalBytes += Number(object.size || 0);
    }
  }
  return {
    manifest,
    objectCount,
    totalBytes,
    outputs: {
      "relay-cleaned-object-count": String(objectCount),
      "relay-cleaned-total-bytes": String(totalBytes),
    },
  };
}
