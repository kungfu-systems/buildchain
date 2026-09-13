import { recordDigest } from "../../release/discussion/envelope.js";
import { object, relativePath } from "../../consumer/contract/shape.js";
import { materializePipelineVersion } from "./version.js";

export function pipelineVersionMaterialPaths(policy, configPath) {
  const primary = [...new Set(policy.files.map(({ path }) => path))];
  const derived = policy.derived_files || [];
  const paths = [...primary, ...derived];
  if (
    !paths.length ||
    paths.length > 128 ||
    new Set(paths).size !== paths.length
  )
    throw new Error(
      "Version material requires a bounded disjoint path inventory",
    );
  for (const file of paths) {
    relativePath(file, "version material path");
    if (
      file.includes("*") ||
      file === configPath ||
      [
        ".buildchain/contract-lock.json",
        ".buildchain/alpha-contract-lock.json",
      ].includes(file) ||
      /^\.(?:git|github)\//u.test(file)
    )
      throw new Error(
        "Version material cannot rewrite its source contract or workflow authority",
      );
  }
  return paths.sort();
}

function checkFiles(files, paths) {
  if (recordDigest(Object.keys(files).sort()) !== recordDigest(paths))
    throw new Error("Version regeneration changed its declared file inventory");
  let total = 0;
  for (const file of paths) {
    if (
      typeof files[file] !== "string" ||
      Buffer.byteLength(files[file]) > 4 * 1024 * 1024
    )
      throw new Error("Version regeneration requires bounded text files");
    total += Buffer.byteLength(files[file]);
  }
  if (total > 64 * 1024 * 1024)
    throw new Error(
      "Version regeneration exceeds its complete material byte limit",
    );
}

// This is an observation from a credentialless product job. A provider adapter
// must qualify its exact producer execution before passing it to collection.
export function pipelineVersionRegenerationResult(
  preparation,
  platform,
  files,
) {
  const paths = pipelineVersionMaterialPaths(
    preparation.versionPolicy,
    preparation.source.configPath,
  );
  checkFiles(files, paths);
  if (!preparation.platforms.includes(platform))
    throw new Error("Version regeneration platform was not declared");
  const body = {
    schema: "buildchain.pipeline-version-regeneration/v1",
    preparationRoot: preparation.root,
    source: preparation.source,
    platform,
    version: preparation.version,
    files,
  };
  return { ...body, root: recordDigest(body) };
}

function qualifiedFiles(preparation, result, paths) {
  object(result, [
    "schema",
    "preparationRoot",
    "source",
    "platform",
    "version",
    "files",
    "root",
  ]);
  const expected = pipelineVersionRegenerationResult(
    preparation,
    result.platform,
    result.files,
  );
  if (recordDigest(result) !== recordDigest(expected))
    throw new Error(
      "Version regeneration changed its preparation, source, version or result root",
    );
  checkFiles(result.files, paths);
  return result.files;
}

export function collectPipelineVersionMaterial(preparation, files, results) {
  const policy = preparation.versionPolicy;
  const paths = pipelineVersionMaterialPaths(
    policy,
    preparation.source.configPath,
  );
  checkFiles(files, paths);
  const expectedPlatforms = [...new Set(preparation.platforms)].sort();
  const actualPlatforms = results.map(({ platform }) => platform).sort();
  if (
    recordDigest(actualPlatforms) !== recordDigest(expectedPlatforms) ||
    !actualPlatforms.length
  )
    throw new Error(
      "Version regeneration requires every declared platform exactly once",
    );
  const material = materializePipelineVersion(
    policy,
    files,
    preparation.version,
  );
  const primary = new Set(policy.files.map(({ path }) => path));
  const expected = {
    ...files,
    ...Object.fromEntries(
      material.changes.map(({ path, content }) => [path, content]),
    ),
  };
  const derived = new Map();
  for (const result of results) {
    const observed = qualifiedFiles(preparation, result, paths);
    for (const file of paths) {
      if (primary.has(file)) {
        if (observed[file] !== expected[file])
          throw new Error(
            "Product commands changed bytes outside the planned version fields",
          );
      } else if (observed[file] !== files[file]) {
        if (derived.has(file) && derived.get(file) !== observed[file])
          throw new Error(
            "Platforms produced conflicting derived version bytes",
          );
        derived.set(file, observed[file]);
      }
    }
  }
  const changes = [...derived].map(([path, content]) => ({
    path,
    before: recordDigest(files[path]),
    content,
    after: recordDigest(content),
  }));
  return {
    ...material,
    changes: [...material.changes, ...changes].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    regenerationRoots: results
      .toSorted((left, right) => left.platform.localeCompare(right.platform))
      .map(({ root }) => root),
  };
}
