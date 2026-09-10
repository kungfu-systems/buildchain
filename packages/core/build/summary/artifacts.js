import fs from "node:fs";
import path from "node:path";
import { findJsonFiles } from "../artifact/files.js";
function parsePlatformIds(parsed, name) {
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }
  const ids = parsed.map((entry) =>
    String(typeof entry === "string" ? entry : entry?.id || "").trim(),
  );
  if (ids.some((id) => !id)) {
    throw new Error(`${name} entries must declare non-empty platform ids`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${name} must not contain duplicate platform ids`);
  }
  return ids;
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function selectPlatformManifests({ inputRoot, expectedPlatformIds }) {
  const candidates = findJsonFiles(inputRoot)
    .filter((file) => path.basename(file) === "manifest.json")
    .sort()
    .map((file) => ({ file, manifest: readManifest(file) }))
    .filter(
      ({ manifest }) => manifest?.contract === "kungfu-buildchain-artifact",
    );
  if (expectedPlatformIds.length === 0) return candidates;
  return expectedPlatformIds.map((platformId) => {
    const matches = candidates.filter(
      ({ manifest }) => manifest.platform?.id === platformId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one platform manifest for ${platformId}, found ${matches.length} under ${inputRoot}`,
      );
    }
    return matches[0];
  });
}

export function aggregateBuildSummary({
  inputRoot,
  outputPath,
  artifactName,
  platforms = [],
  additionalPlatforms = [],
  expectedPlatformCount = platforms.length,
  additionalPlatformCount = additionalPlatforms.length,
  git,
  publishGate,
  publishSource,
  runtime,
}) {
  if (
    !Number.isInteger(additionalPlatformCount) ||
    additionalPlatformCount < 0
  ) {
    throw new Error(
      "BUILDCHAIN_ADDITIONAL_PLATFORM_COUNT must be a non-negative integer",
    );
  }
  const expectedManifestCount = expectedPlatformCount + additionalPlatformCount;
  const platformIds = parsePlatformIds(platforms, "platforms");
  const additionalPlatformIds = parsePlatformIds(
    additionalPlatforms,
    "additionalPlatforms",
  );
  if (platformIds.length > 0 && platformIds.length !== expectedPlatformCount) {
    throw new Error(
      `BUILDCHAIN_EXPECTED_PLATFORMS_JSON declares ${platformIds.length} platforms, expected ${expectedPlatformCount}`,
    );
  }
  if (additionalPlatformIds.length !== additionalPlatformCount) {
    throw new Error(
      `BUILDCHAIN_ADDITIONAL_PLATFORM_IDS_JSON declares ${additionalPlatformIds.length} platforms, expected ${additionalPlatformCount}`,
    );
  }
  const expectedPlatformIds = [...platformIds, ...additionalPlatformIds];
  if (new Set(expectedPlatformIds).size !== expectedPlatformIds.length) {
    throw new Error(
      "declared platform ids must be unique across primary and additional platforms",
    );
  }
  const selected = selectPlatformManifests({
    inputRoot,
    expectedPlatformIds,
  });
  const manifestFiles = selected.map(({ file }) => file);
  const manifests = selected.map(({ manifest }) => manifest);
  if (expectedManifestCount > 0 && manifests.length !== expectedManifestCount) {
    throw new Error(
      `expected ${expectedManifestCount} platform manifests, found ${manifests.length} under ${inputRoot}`,
    );
  }
  const summary = {
    contract: "kungfu-buildchain-build-summary",
    artifactName,
    git,
    publishGate,
    publishSource,
    runtime,
    platformCount: manifests.length,
    fileCount: manifests.reduce(
      (sum, manifest) => sum + Number(manifest.summary?.fileCount || 0),
      0,
    ),
    totalBytes: manifests.reduce(
      (sum, manifest) => sum + Number(manifest.summary?.totalBytes || 0),
      0,
    ),
    observability: {
      lifecycle: {
        stages: manifests.reduce((acc, manifest) => {
          for (const [stage, value] of Object.entries(
            manifest.observability?.lifecycle?.stages || {},
          )) {
            acc[stage] = acc[stage] || { durationMs: 0, eventCount: 0 };
            acc[stage].durationMs += Number(value.durationMs || 0);
            acc[stage].eventCount += Number(value.eventCount || 0);
          }
          return acc;
        }, {}),
        topSlowSpans: manifests
          .flatMap(
            (manifest) => manifest.observability?.lifecycle?.topSlowSpans || [],
          )
          .sort(
            (left, right) =>
              Number(right.durationMs || 0) - Number(left.durationMs || 0),
          )
          .slice(0, 10),
        warningCount: manifests.reduce(
          (sum, manifest) =>
            sum + Number(manifest.observability?.lifecycle?.warningCount || 0),
          0,
        ),
        errorCount: manifests.reduce(
          (sum, manifest) =>
            sum + Number(manifest.observability?.lifecycle?.errorCount || 0),
          0,
        ),
      },
    },
    platforms: manifests.map((manifest, index) => ({
      artifactName: manifest.artifactName,
      platform: manifest.platform,
      summary: manifest.summary,
      observability: manifest.observability,
      expectedArtifacts: manifest.expectedArtifacts,
      manifestPath: manifestFiles[index],
    })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
