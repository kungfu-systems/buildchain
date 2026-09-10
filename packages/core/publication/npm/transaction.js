import fs from "node:fs";
import path from "node:path";
import { runNpm, publishedDigest } from "./registry.js";
import {
  readPackageJson,
  sealedPackResult,
  materializedPackResult,
  artifactDigest,
} from "./package.js";
import {
  assertPackageVersion,
  writeEvidence,
  npmPublicationEvidence,
} from "./evidence.js";
export function npmPublishTransaction({
  cwd,
  publication,
  env,
  registry = "https://registry.npmjs.org/",
  dryRunPublish = false,
  access = "public",
  skipRegistryLookup = false,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const pkg = readPackageJson(resolvedCwd);
  const expectedVersion = publication.version || "";
  const exactTag = assertPackageVersion({ pkg, expectedVersion });
  const distTag =
    publication.distTag || (pkg.version.includes("-") ? "alpha" : "latest");

  const evidencePath = publication.evidencePath;
  if (typeof evidencePath !== "string" || !evidencePath.trim())
    throw new Error("Publication evidencePath is required before npm effects");

  const pack =
    sealedPackResult(publication) ||
    materializedPackResult({ cwd: resolvedCwd, registry, env });
  const digest = artifactDigest(pack);

  try {
    const existingDigest = skipRegistryLookup
      ? undefined
      : publishedDigest({
          env,
          cwd: resolvedCwd,
          name: pkg.name,
          version: pkg.version,
          registry,
        });
    let publishAction = "already-published";
    if (existingDigest) {
      if (existingDigest !== digest) {
        throw new Error(
          `artifact digest mismatch: npm:${pkg.name}@${pkg.version}`,
        );
      }
    } else if (dryRunPublish) {
      publishAction = "dry-run";
    } else {
      runNpm({
        env,
        cwd: resolvedCwd,
        args: [
          "publish",
          ...(pack.tarballPath ? [pack.tarballPath] : []),
          "--access",
          access,
          "--tag",
          distTag,
          `--registry=${registry}`,
        ],
      });
      publishAction = "published";
      const registryDigest = skipRegistryLookup
        ? undefined
        : publishedDigest({
            env,
            cwd: resolvedCwd,
            name: pkg.name,
            version: pkg.version,
            registry,
          });
      if (registryDigest && registryDigest !== digest) {
        throw new Error(
          `artifact digest mismatch: npm:${pkg.name}@${pkg.version}`,
        );
      }
    }

    const evidence = npmPublicationEvidence({ publication, pkg, digest });
    const resolvedEvidencePath = writeEvidence({
      cwd: resolvedCwd,
      evidencePath,
      evidence,
    });
    return {
      schemaVersion: 1,
      package: {
        name: pkg.name,
        version: pkg.version,
      },
      exactTag,
      distTag,
      registry,
      publishAction,
      pack: { ...pack, temporaryRoot: undefined },
      sealedBundleRoot: publication.sealedBundleRoot || "",
      evidencePath: resolvedEvidencePath,
      evidence,
    };
  } finally {
    if (pack.temporaryRoot)
      fs.rmSync(pack.temporaryRoot, { recursive: true, force: true });
  }
}
